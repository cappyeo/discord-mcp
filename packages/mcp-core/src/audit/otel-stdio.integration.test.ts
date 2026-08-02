import { REST } from '@discordjs/rest';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
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

/**
 * Plan 8 Phase F.3 - in-process variant of the deferred Phase A
 * otel-stdio integration test.
 *
 * The original plan called for spawning the mcp-server CLI with
 * OTEL_ENABLED=true OTEL_CONSOLE_EXPORTER=true and grepping stdout for
 * span JSON. The plan offers a simpler variant: in-process boot of
 * `buildServer` + an InMemorySpanExporter, and assert spans contain
 * mcp.tool.name. We take the simpler variant per plan critical rule 4
 * (no child processes unless absolutely necessary).
 *
 * We assert:
 *   - A SERVER span is exported with name `mcp.tool.<name>`.
 *   - The span carries the expected attributes (mcp.tool.name,
 *     mcp.tool.category, mcp.tool.idempotent, mcp.transport).
 *   - The mcp.tool.args event is present (Phase F.2).
 *
 * Boot path: client ↔ InMemoryTransport ↔ server (full middleware
 * chain).  No CLI spawn.
 */

describe('otel-stdio integration (Plan 8 F.3, in-process variant)', () => {
  const fakeEnv = {
    DISCORD_TOKEN: 'Bot fake.test.token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    LOG_LEVEL: 'fatal',
  } as NodeJS.ProcessEnv;
  const config = loadConfig(fakeEnv);
  const logger = createLogger(config);

  let client: Client;
  let spanExporter: InMemorySpanExporter;
  let tracerProvider: BasicTracerProvider;
  let meterProvider: MeterProvider;

  beforeAll(async () => {
    spanExporter = new InMemorySpanExporter();
    tracerProvider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(spanExporter)],
    });
    trace.setGlobalTracerProvider(tracerProvider);
    meterProvider = new MeterProvider();
    metrics.setGlobalMeterProvider(meterProvider);

    const rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token');
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const built = await buildServer({ rest, logger, config });
    client = new Client({ name: 'otel-stdio-it', version: '0.0.0' }, { capabilities: {} });
    await Promise.all([built.server.connect(serverTransport), client.connect(clientTransport)]);
  });

  afterAll(async () => {
    await client.close();
    trace.disable();
    metrics.disable();
    await tracerProvider.shutdown();
    await meterProvider.shutdown();
  });

  it('exports a SERVER span with mcp.tool.<name> + standard attributes', async () => {
    spanExporter.reset();

    const r = await client.callTool({
      name: 'messages_send',
      arguments: { channel_id: '112233445566778899', content: 'otel-stdio-it' },
    });
    expect(r.isError).toBe(false);

    const spans = spanExporter.getFinishedSpans();
    const toolSpan = spans.find((s) => s.name === 'mcp.tool.messages_send') as
      | ReadableSpan
      | undefined;
    expect(toolSpan, 'expected an mcp.tool.messages_send SERVER span').toBeDefined();
    expect(toolSpan?.kind).toBe(1); // SpanKind.SERVER
    expect(toolSpan?.attributes['mcp.tool.name']).toBe('messages_send');
    expect(toolSpan?.attributes['mcp.tool.category']).toBe('messages');
    expect(toolSpan?.attributes['mcp.tool.idempotent']).toBe(false);
    expect(toolSpan?.attributes['mcp.transport']).toBe('stdio');
  });

  it('emits the mcp.tool.args span event populated by Phase F.2 redaction', async () => {
    spanExporter.reset();

    await client.callTool({
      name: 'messages_send',
      arguments: { channel_id: '112233445566778899', content: 'hello' },
    });

    const toolSpan = spanExporter
      .getFinishedSpans()
      .find((s) => s.name === 'mcp.tool.messages_send');
    expect(toolSpan).toBeDefined();
    const argsEvent = toolSpan?.events.find((e) => e.name === 'mcp.tool.args');
    expect(argsEvent).toBeDefined();
    expect(typeof argsEvent?.attributes?.['mcp.args.redacted']).toBe('string');
  });
});
