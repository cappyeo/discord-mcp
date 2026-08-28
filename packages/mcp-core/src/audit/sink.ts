import { createWriteStream, type WriteStream } from 'node:fs';
import type { Config } from '../config.js';
import type { AuditEvent } from './schema.js';

/**
 * Audit sink contract (Plan 8 Phase E).
 *
 * Implementations encode an `AuditEvent` to their target. `emit` MUST NOT
 * throw - sinks are best-effort. `shutdown` (optional) flushes / closes
 * any underlying file or network resource on SIGTERM. The default file
 * path used when `MCP_AUDIT_SINK=file` and `MCP_AUDIT_FILE` is unset.
 */
export const DEFAULT_AUDIT_FILE = './discord-mcp-audit.jsonl';

export interface AuditSink {
  emit(event: AuditEvent): Promise<void>;
  shutdown?(): Promise<void>;
}

/**
 * Transport-neutral adapter used when the server owns an OpenTelemetry logs
 * provider. Core deliberately knows only this small boundary; importing an
 * OTel SDK here would force every embedders' dependency graph to include it.
 */
export interface AuditLogEmitter {
  emit(event: AuditEvent): void | Promise<void>;
  /** Flush buffered records without taking ownership of provider shutdown. */
  forceFlush?(): Promise<void>;
}

/**
 * StderrAuditSink - writes one JSON line to `process.stderr` per event,
 * with a `level: 'audit'` field so log aggregators can route audit
 * records separately from app logs.
 *
 * Stderr is the only safe stream in stdio MCP transports - stdout is
 * reserved for JSON-RPC frames. See transports/stdio.ts.
 */
export class StderrAuditSink implements AuditSink {
  async emit(event: AuditEvent): Promise<void> {
    try {
      const line = `${JSON.stringify({ level: 'audit', ...event })}\n`;
      process.stderr.write(line);
    } catch {
      // Best-effort: never let audit failure break tool execution.
    }
  }
}

/**
 * FileAuditSink - append-only JSON-lines file. Stream is opened once
 * with `flags: 'a'` so concurrent process restarts append cleanly. The
 * file path defaults to `DEFAULT_AUDIT_FILE` when undefined.
 *
 * `shutdown()` closes the stream and resolves once Node has flushed
 * pending writes. Subsequent `emit` calls become no-ops.
 */
export class FileAuditSink implements AuditSink {
  private readonly stream: WriteStream;
  private closed = false;

  constructor(filePath: string = DEFAULT_AUDIT_FILE) {
    this.stream = createWriteStream(filePath, { flags: 'a', encoding: 'utf8' });
    // Swallow async stream errors - surface via stderr instead of throwing.
    this.stream.on('error', (err) => {
      try {
        process.stderr.write(
          `${JSON.stringify({
            level: 'warn',
            msg: 'audit file sink stream error',
            err: err.message,
          })}\n`,
        );
      } catch {
        // ignore - last-resort; never throw from a sink.
      }
    });
  }

  async emit(event: AuditEvent): Promise<void> {
    if (this.closed) return;
    try {
      const line = `${JSON.stringify(event)}\n`;
      this.stream.write(line);
    } catch {
      // Best-effort - same contract as Stderr sink.
    }
  }

  shutdown(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.closed = true;
    return new Promise<void>((resolve) => {
      this.stream.end(() => resolve());
    });
  }
}

/**
 * OtlpAuditSink - a transport-neutral adapter for the server-owned OTel logs
 * provider. When no emitter is injected (for example an embedding that only
 * imports core, or OTEL is disabled), it keeps the explicit stderr fallback so
 * selecting `MCP_AUDIT_SINK=otlp` never silently drops audit events.
 */
export class OtlpAuditSink implements AuditSink {
  public constructor(private readonly emitter?: AuditLogEmitter) {}

  async emit(event: AuditEvent): Promise<void> {
    if (this.emitter !== undefined) {
      try {
        await this.emitter.emit(event);
      } catch {
        // The audit contract is best-effort and must never turn a completed
        // Discord mutation into a tool failure. Do not print the event here:
        // it may contain sensitive-but-redacted payload metadata.
        this.writeWarning('otlp audit emitter failed');
      }
      return;
    }
    this.writeFallback(event);
  }

  async shutdown(): Promise<void> {
    if (this.emitter?.forceFlush === undefined) return;
    try {
      await this.emitter.forceFlush();
    } catch {
      this.writeWarning('otlp audit emitter flush failed');
    }
  }

  private writeFallback(event: AuditEvent): void {
    try {
      const line = `[FALLBACK:logs-pipeline-not-wired] ${JSON.stringify({
        level: 'audit',
        ...event,
      })}\n`;
      process.stderr.write(line);
    } catch {
      // ignore
    }
  }

  private writeWarning(message: string): void {
    try {
      process.stderr.write(`${JSON.stringify({ level: 'warn', msg: message })}\n`);
    } catch {
      // ignore
    }
  }
}

/**
 * NoopAuditSink - used when audit is disabled (`MCP_AUDIT_ENABLED=false`)
 * or `MCP_AUDIT_SINK=none`. The middleware still runs (cheap), but
 * `emit` is a no-op so no I/O happens.
 */
export class NoopAuditSink implements AuditSink {
  async emit(_event: AuditEvent): Promise<void> {
    /* no-op */
  }
}

/**
 * Factory: pick the audit sink based on `Config`.
 *
 * Per plan §10 critical rule 5: when `MCP_AUDIT_ENABLED=false`,
 * **always** return `NoopAuditSink`, regardless of `MCP_AUDIT_SINK`.
 * Same for the explicit `MCP_AUDIT_SINK=none` opt-out. Otherwise
 * dispatch on the enum.
 */
export function createAuditSink(
  config: Config,
  options: { readonly otlpEmitter?: AuditLogEmitter } = {},
): AuditSink {
  if (!config.MCP_AUDIT_ENABLED) {
    return new NoopAuditSink();
  }
  switch (config.MCP_AUDIT_SINK) {
    case 'none':
      return new NoopAuditSink();
    case 'file':
      return new FileAuditSink(config.MCP_AUDIT_FILE);
    case 'otlp':
      return new OtlpAuditSink(options.otlpEmitter);
    default:
      return new StderrAuditSink();
  }
}
