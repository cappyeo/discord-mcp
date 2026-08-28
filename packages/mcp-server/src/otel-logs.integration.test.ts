import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AuditEvent } from '@discord-mcp/core';
import { loadConfig } from '@discord-mcp/core';
import { metrics, trace } from '@opentelemetry/api';
import { logs } from '@opentelemetry/api-logs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildAuditLogRecord, startOtel } from './otel.js';

const VALID_TOKEN = 'Bot fake.test.token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const event: AuditEvent = {
  timestamp: '2026-08-28T00:00:00.000Z',
  request_id: 'request-otel-1',
  tool: 'messages_send',
  category: 'messages',
  idempotent: false,
  args_redacted: { channel_id: '111122223333444455', content: '[REDACTED:12ch]' },
  status: 'success',
  duration_ms: 4,
  transport: 'stdio',
};

let collector: HttpServer;
let endpoint: string;
const logRequests: Array<{
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}> = [];

beforeAll(async () => {
  collector = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString('utf8');
    if (request.url === '/v1/logs') {
      logRequests.push({
        headers: request.headers,
        body: raw.length === 0 ? null : JSON.parse(raw),
      });
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{}');
  });
  await new Promise<void>((resolve) => collector.listen(0, '127.0.0.1', resolve));
  const address = collector.address() as AddressInfo;
  endpoint = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    collector.close((error) => (error ? reject(error) : resolve())),
  );
});

describe('OTLP audit logs', () => {
  it('maps a redacted audit event to bounded log attributes', () => {
    const record = buildAuditLogRecord(event);
    expect(record.severityText).toBe('INFO');
    expect(JSON.parse(record.body)).toMatchObject({ level: 'audit', tool: 'messages_send' });
    expect(record.attributes).toMatchObject({
      'mcp.audit.tool': 'messages_send',
      'mcp.audit.status': 'success',
      'mcp.audit.idempotent': false,
    });
    expect(JSON.stringify(record.attributes)).not.toContain('REDACTED');
  });

  it('exports the audit record to a loopback OTLP /v1/logs endpoint and flushes it', async () => {
    const config = loadConfig({
      DISCORD_TOKEN: VALID_TOKEN,
      OTEL_ENABLED: 'true',
      OTEL_EXPORTER_OTLP_ENDPOINT: endpoint,
      OTEL_EXPORTER_OTLP_HEADERS: 'x-test-secret=collector-secret',
      OTEL_TRACES_SAMPLER: 'always_off',
      MCP_AUDIT_SINK: 'otlp',
      MCP_AUDIT_ENABLED: 'true',
      LOG_LEVEL: 'fatal',
    } as NodeJS.ProcessEnv);
    const handle = startOtel(config);
    expect(handle?.auditEmitter).toBeDefined();
    handle?.auditEmitter?.emit(event);
    await handle?.auditEmitter?.forceFlush?.();
    await handle?.shutdown();

    expect(logRequests.length).toBeGreaterThanOrEqual(1);
    const request = logRequests[logRequests.length - 1]!;
    expect(request.headers['x-test-secret']).toBe('collector-secret');
    const body = request.body as {
      resourceLogs?: Array<{
        resource?: { attributes?: Array<{ key: string; value: { stringValue?: string } }> };
        scopeLogs?: Array<{
          scope?: { name?: string; version?: string };
          logRecords?: Array<{ body?: { stringValue?: string } }>;
        }>;
      }>;
    };
    const resourceAttributes = body.resourceLogs?.[0]?.resource?.attributes ?? [];
    const resource = new Map(
      resourceAttributes.map((attribute) => [attribute.key, attribute.value.stringValue]),
    );
    expect(resource.get('service.name')).toBe('discord-mcp');
    const records =
      body.resourceLogs?.[0]?.scopeLogs?.flatMap((scope) => scope.logRecords ?? []) ?? [];
    expect(body.resourceLogs?.[0]?.scopeLogs?.[0]?.scope).toMatchObject({
      name: 'discord-mcp.audit',
      version: config.OTEL_SERVICE_VERSION,
    });
    const exportedBody = records.find((record) =>
      record.body?.stringValue?.includes('request-otel-1'),
    );
    expect(exportedBody?.body?.stringValue).toContain('messages_send');
    expect(exportedBody?.body?.stringValue).toContain('[REDACTED:12ch]');
    expect(exportedBody?.body?.stringValue).not.toContain('collector-secret');
    logs.disable();
    metrics.disable();
    trace.disable();
  });
});
