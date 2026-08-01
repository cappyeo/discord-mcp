import { REST } from '@discordjs/rest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { metrics, trace } from '@opentelemetry/api';
import { MeterProvider } from '@opentelemetry/sdk-metrics';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { createLogger } from '../logger.js';
import { buildServer } from '../server.js';
import type { AuditEvent } from './schema.js';
import type { AuditSink } from './sink.js';

/**
 * End-to-end integration test (Plan 8 Phase F.3) for the redaction
 * pipeline. Calls `messages_send` with a sensitive `content` value and
 * asserts that the redacted form propagates to BOTH:
 *
 *   1. The AuditEvent.args_redacted field via the audit sink path.
 *   2. The `mcp.tool.args` span event's `mcp.args.redacted` attribute
 *      via the telemetry middleware path.
 *
 * The raw "secret data" string MUST NOT appear in either output.
 *
 * Uses the in-memory MCP transport (no child process) and an in-memory
 * span exporter (no OTLP exporter wired) - the full stack but with
 * deterministic capture points.
 */

class CapturingSink implements AuditSink {
  readonly events: AuditEvent[] = [];
  async emit(event: AuditEvent): Promise<void> {
    this.events.push(event);
  }
}

describe('redaction integration (Plan 8 F.3)', () => {
  const fakeEnv = {
    DISCORD_TOKEN: 'Bot fake.test.token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    LOG_LEVEL: 'fatal',
    MCP_AUDIT_ENABLED: 'true',
    MCP_AUDIT_SINK: 'stderr',
  } as NodeJS.ProcessEnv;
  const config = loadConfig(fakeEnv);
  const logger = createLogger(config);

  let client: Client;
  let captured: CapturingSink;
  let spanExporter: InMemorySpanExporter;
  let tracerProvider: BasicTracerProvider;
  let meterProvider: MeterProvider;

  beforeAll(async () => {
    // Wire span exporter BEFORE buildServer so the telemetry middleware
    // sees the active provider.
    spanExporter = new InMemorySpanExporter();
    tracerProvider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(spanExporter)],
    });
    trace.setGlobalTracerProvider(tracerProvider);
    meterProvider = new MeterProvider();
    metrics.setGlobalMeterProvider(meterProvider);

    captured = new CapturingSink();
    const rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token');
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const built = await buildServer({ rest, logger, config });
    // Hot-swap audit sink emit() to capture events.
    built.auditSink.emit = (ev) => captured.emit(ev);

    client = new Client({ name: 'redaction-it', version: '0.0.0' }, { capabilities: {} });
    await Promise.all([built.server.connect(serverTransport), client.connect(clientTransport)]);
  });

  afterAll(async () => {
    await client.close();
    trace.disable();
    metrics.disable();
    await tracerProvider.shutdown();
    await meterProvider.shutdown();
  });

  it('redacts content end-to-end in audit + span (Plan 8 F.1 + F.2)', async () => {
    captured.events.length = 0;
    spanExporter.reset();

    // "secret data" is 11 characters - assertion-friendly length.
    const SECRET = 'secret data';
    expect(SECRET.length).toBe(11);

    const r = await client.callTool({
      name: 'messages_send',
      arguments: { channel_id: '112233445566778899', content: SECRET },
    });
    expect(r.isError).toBe(false);

    // 1. Audit path - args_redacted.content === '[REDACTED:11ch]'.
    expect(captured.events).toHaveLength(1);
    const ev = captured.events[0]!;
    expect(ev.args_redacted).toMatchObject({
      channel_id: '112233445566778899',
      content: '[REDACTED:11ch]',
    });
    // Stringified event must NOT contain the raw secret.
    expect(JSON.stringify(ev)).not.toContain(SECRET);

    // 2. Span path - mcp.tool.args event's mcp.args.redacted attribute.
    const spans = spanExporter.getFinishedSpans();
    const toolSpan = spans.find((s) => s.name === 'mcp.tool.messages_send') as
      | ReadableSpan
      | undefined;
    expect(toolSpan, 'expected an mcp.tool.messages_send span').toBeDefined();
    const argsEvent = toolSpan?.events.find((e) => e.name === 'mcp.tool.args');
    expect(argsEvent, 'expected mcp.tool.args event on the span').toBeDefined();
    const redactedJson = argsEvent?.attributes?.['mcp.args.redacted'] as string;
    expect(redactedJson).toBeDefined();
    expect(redactedJson).toContain('[REDACTED:11ch]');
    expect(redactedJson).not.toContain(SECRET);

    // 3. Cross-check: no span attribute anywhere on the tool span
    //    leaks "secret data" - defense in depth against future regressions.
    for (const [, v] of Object.entries(toolSpan?.attributes ?? {})) {
      expect(String(v)).not.toContain(SECRET);
    }
  });
});
