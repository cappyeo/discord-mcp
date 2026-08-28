import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../config.js';
import type { AuditEvent } from './schema.js';
import {
  type AuditLogEmitter,
  createAuditSink,
  FileAuditSink,
  NoopAuditSink,
  OtlpAuditSink,
  StderrAuditSink,
} from './sink.js';

const VALID_TOKEN = 'Bot fake.test.token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

const sampleEvent: AuditEvent = {
  timestamp: '2026-05-01T00:00:00.000Z',
  request_id: 'req-1',
  tool: 'messages_send',
  category: 'messages',
  idempotent: false,
  args_redacted: { channel_id: '111' },
  status: 'success',
  duration_ms: 5,
  transport: 'stdio',
};

describe('StderrAuditSink', () => {
  let writeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    writeSpy.mockRestore();
  });

  it('writes a single JSON line with level=audit per event', async () => {
    const sink = new StderrAuditSink();
    await sink.emit(sampleEvent);
    expect(writeSpy).toHaveBeenCalledTimes(1);
    const line = writeSpy.mock.calls[0]?.[0] as string;
    expect(line.endsWith('\n')).toBe(true);
    const parsed = JSON.parse(line.trim()) as { level: string; tool: string };
    expect(parsed.level).toBe('audit');
    expect(parsed.tool).toBe('messages_send');
  });

  it('does not throw when stderr.write fails', async () => {
    writeSpy.mockImplementation(() => {
      throw new Error('EPIPE');
    });
    const sink = new StderrAuditSink();
    await expect(sink.emit(sampleEvent)).resolves.toBeUndefined();
  });
});

describe('FileAuditSink', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'discord-mcp-audit-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes JSON-parseable lines and supports append mode (2 calls → 2 lines)', async () => {
    const file = join(dir, 'audit.jsonl');
    const sink = new FileAuditSink(file);
    await sink.emit(sampleEvent);
    await sink.emit({ ...sampleEvent, request_id: 'req-2' });
    await sink.shutdown();

    const content = readFileSync(file, 'utf8');
    const lines = content.split('\n').filter((l) => l.length > 0);
    expect(lines).toHaveLength(2);
    const parsed0 = JSON.parse(lines[0] as string) as AuditEvent;
    const parsed1 = JSON.parse(lines[1] as string) as AuditEvent;
    expect(parsed0.request_id).toBe('req-1');
    expect(parsed1.request_id).toBe('req-2');
  });

  it('appends to an existing file rather than truncating it', async () => {
    const file = join(dir, 'audit.jsonl');
    const sink1 = new FileAuditSink(file);
    await sink1.emit({ ...sampleEvent, request_id: 'first' });
    await sink1.shutdown();

    const sink2 = new FileAuditSink(file);
    await sink2.emit({ ...sampleEvent, request_id: 'second' });
    await sink2.shutdown();

    const lines = readFileSync(file, 'utf8')
      .split('\n')
      .filter((l) => l.length > 0);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).request_id).toBe('first');
    expect(JSON.parse(lines[1]!).request_id).toBe('second');
  });

  it('emit becomes a no-op after shutdown', async () => {
    const file = join(dir, 'audit.jsonl');
    const sink = new FileAuditSink(file);
    await sink.emit(sampleEvent);
    await sink.shutdown();
    await sink.emit({ ...sampleEvent, request_id: 'after-shutdown' });

    const lines = readFileSync(file, 'utf8')
      .split('\n')
      .filter((l) => l.length > 0);
    expect(lines).toHaveLength(1);
  });

  it('swallows synchronous stream write failures', async () => {
    const file = join(dir, 'audit-write-error.jsonl');
    const sink = new FileAuditSink(file);
    const stream = sink as unknown as {
      stream: { write: () => void; end: (cb: () => void) => void };
    };
    stream.stream.write = () => {
      throw new Error('write failed');
    };
    await expect(sink.emit(sampleEvent)).resolves.toBeUndefined();
    await sink.shutdown();
  });

  it('reports asynchronous stream errors without throwing', async () => {
    const file = join(dir, 'audit-stream-error.jsonl');
    const sink = new FileAuditSink(file);
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const stream = sink as unknown as {
      stream: { emit: (event: string, error: Error) => boolean };
    };
    stream.stream.emit('error', new Error('stream failed'));
    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(String(writeSpy.mock.calls[0]?.[0])).toContain('audit file sink stream error');
    writeSpy.mockRestore();
    await sink.shutdown();
  });
});

describe('NoopAuditSink', () => {
  it('emit resolves without writing anywhere', async () => {
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const sink = new NoopAuditSink();
    await sink.emit(sampleEvent);
    expect(writeSpy).not.toHaveBeenCalled();
    writeSpy.mockRestore();
  });
});

describe('OtlpAuditSink', () => {
  let writeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    writeSpy.mockRestore();
  });

  it('falls back to stderr with [FALLBACK:logs-pipeline-not-wired] prefix', async () => {
    const sink = new OtlpAuditSink();
    await sink.emit(sampleEvent);
    expect(writeSpy).toHaveBeenCalledTimes(1);
    const line = writeSpy.mock.calls[0]?.[0] as string;
    expect(line.startsWith('[FALLBACK:logs-pipeline-not-wired] ')).toBe(true);
    const json = line.replace('[FALLBACK:logs-pipeline-not-wired] ', '').trim();
    const parsed = JSON.parse(json) as { level: string; tool: string };
    expect(parsed.level).toBe('audit');
    expect(parsed.tool).toBe('messages_send');
  });

  it('delegates to an injected emitter without writing the audit event to stderr', async () => {
    const emitter: AuditLogEmitter = { emit: vi.fn() };
    const sink = new OtlpAuditSink(emitter);
    await sink.emit(sampleEvent);
    expect(emitter.emit).toHaveBeenCalledWith(sampleEvent);
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('does not throw when the injected emitter fails and flushes on shutdown', async () => {
    const emitter: AuditLogEmitter = {
      emit: vi.fn().mockRejectedValue(new Error('collector down')),
      forceFlush: vi.fn().mockRejectedValue(new Error('flush failed')),
    };
    const sink = new OtlpAuditSink(emitter);
    await expect(sink.emit(sampleEvent)).resolves.toBeUndefined();
    await expect(sink.shutdown()).resolves.toBeUndefined();
    expect(emitter.emit).toHaveBeenCalledOnce();
    expect(emitter.forceFlush).toHaveBeenCalledOnce();
    expect(writeSpy).toHaveBeenCalledTimes(2);
    expect(String(writeSpy.mock.calls[0]?.[0])).not.toContain('messages_send');
  });

  it('keeps emitter warning handling best-effort even when stderr is closed', async () => {
    const emitter: AuditLogEmitter = {
      emit: vi.fn().mockRejectedValue(new Error('collector down')),
    };
    const sink = new OtlpAuditSink(emitter);
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => {
      throw new Error('EPIPE');
    });
    await expect(sink.emit(sampleEvent)).resolves.toBeUndefined();
    writeSpy.mockRestore();
  });
});

describe('createAuditSink factory', () => {
  it('returns StderrAuditSink for default config (MCP_AUDIT_SINK=stderr)', () => {
    const cfg = loadConfig({ DISCORD_TOKEN: VALID_TOKEN } as NodeJS.ProcessEnv);
    expect(createAuditSink(cfg)).toBeInstanceOf(StderrAuditSink);
  });

  it('returns FileAuditSink when MCP_AUDIT_SINK=file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'discord-mcp-audit-factory-'));
    try {
      const cfg = loadConfig({
        DISCORD_TOKEN: VALID_TOKEN,
        MCP_AUDIT_SINK: 'file',
        MCP_AUDIT_FILE: join(dir, 'audit.jsonl'),
      } as NodeJS.ProcessEnv);
      const sink = createAuditSink(cfg);
      expect(sink).toBeInstanceOf(FileAuditSink);
      await (sink as FileAuditSink).shutdown();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns OtlpAuditSink when MCP_AUDIT_SINK=otlp', () => {
    const cfg = loadConfig({
      DISCORD_TOKEN: VALID_TOKEN,
      MCP_AUDIT_SINK: 'otlp',
    } as NodeJS.ProcessEnv);
    expect(createAuditSink(cfg)).toBeInstanceOf(OtlpAuditSink);
  });

  it('injects the OTel emitter only at the transport boundary', () => {
    const cfg = loadConfig({
      DISCORD_TOKEN: VALID_TOKEN,
      MCP_AUDIT_SINK: 'otlp',
    } as NodeJS.ProcessEnv);
    const emitter: AuditLogEmitter = { emit: vi.fn() };
    const sink = createAuditSink(cfg, { otlpEmitter: emitter });
    expect(sink).toBeInstanceOf(OtlpAuditSink);
  });

  it('keeps the explicit fallback when OTLP is selected without a server emitter', async () => {
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const cfg = loadConfig({
      DISCORD_TOKEN: VALID_TOKEN,
      MCP_AUDIT_SINK: 'otlp',
    } as NodeJS.ProcessEnv);
    const sink = createAuditSink(cfg);
    await sink.emit(sampleEvent);
    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(String(writeSpy.mock.calls[0]?.[0])).toContain('[FALLBACK:logs-pipeline-not-wired]');
    writeSpy.mockRestore();
  });

  it('returns NoopAuditSink when MCP_AUDIT_SINK=none', () => {
    const cfg = loadConfig({
      DISCORD_TOKEN: VALID_TOKEN,
      MCP_AUDIT_SINK: 'none',
    } as NodeJS.ProcessEnv);
    expect(createAuditSink(cfg)).toBeInstanceOf(NoopAuditSink);
  });

  it('returns NoopAuditSink when MCP_AUDIT_ENABLED=false (overrides MCP_AUDIT_SINK)', () => {
    for (const sinkChoice of ['stderr', 'file', 'otlp', 'none'] as const) {
      const cfg = loadConfig({
        DISCORD_TOKEN: VALID_TOKEN,
        MCP_AUDIT_ENABLED: 'false',
        MCP_AUDIT_SINK: sinkChoice,
      } as NodeJS.ProcessEnv);
      expect(createAuditSink(cfg)).toBeInstanceOf(NoopAuditSink);
    }
  });
});
