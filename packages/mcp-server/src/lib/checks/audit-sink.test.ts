import * as path from 'node:path';
import type { Config } from '@discord-mcp/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// vi.mock must be hoisted ABOVE the audit-sink.js import. ESM namespace
// objects (e.g. `import * as fs from 'node:fs'`) are non-configurable, so
// vi.spyOn(fs, 'accessSync') throws — we have to mock the module instead.
// `accessSyncImpl` is a runtime-mutable function that each test rebinds
// before calling auditSinkCheck.run().
let accessSyncImpl: (...args: unknown[]) => void = () => undefined;

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    accessSync: ((...args: unknown[]) => accessSyncImpl(...args)) as typeof actual.accessSync,
  };
});

const { auditSinkCheck } = await import('./audit-sink.js');

function makeConfig(overrides: Partial<Config>): Config {
  // We construct only the fields auditSinkCheck reads. The check signature
  // takes Config, but it only touches MCP_AUDIT_SINK and MCP_AUDIT_FILE,
  // so a structural cast is safe and avoids requiring zod here.
  return overrides as unknown as Config;
}

beforeEach(() => {
  // Reset to a permissive default (everything writable) before each test.
  accessSyncImpl = () => undefined;
});

afterEach(() => {
  accessSyncImpl = () => undefined;
});

describe('auditSinkCheck', () => {
  it('has the correct id, description, and online flag', () => {
    expect(auditSinkCheck.id).toBe('audit-sink');
    expect(auditSinkCheck.description).toBe('Audit sink writability');
    expect(auditSinkCheck.online).toBe(false);
  });

  it('returns warn when config is null (env-vars failed)', async () => {
    const r = await auditSinkCheck.run(null);
    expect(r.status).toBe('warn');
    expect(r.message).toContain('env-vars');
  });

  it('returns ok for stderr sink without filesystem probe', async () => {
    const cfg = makeConfig({ MCP_AUDIT_SINK: 'stderr' });
    const r = await auditSinkCheck.run(cfg);
    expect(r.status).toBe('ok');
    expect(r.details?.sink).toBe('stderr');
  });

  it('returns ok for otlp sink', async () => {
    const cfg = makeConfig({ MCP_AUDIT_SINK: 'otlp' });
    const r = await auditSinkCheck.run(cfg);
    expect(r.status).toBe('ok');
    expect(r.details?.sink).toBe('otlp');
  });

  it('returns ok for none sink', async () => {
    const cfg = makeConfig({ MCP_AUDIT_SINK: 'none' });
    const r = await auditSinkCheck.run(cfg);
    expect(r.status).toBe('ok');
    expect(r.details?.sink).toBe('none');
  });

  it('returns ok for file sink when accessSync passes (file exists)', async () => {
    const cfg = makeConfig({
      MCP_AUDIT_SINK: 'file',
      MCP_AUDIT_FILE: '/tmp/discord-mcp-audit.jsonl',
    });
    let calls = 0;
    accessSyncImpl = () => {
      calls += 1;
    };
    const r = await auditSinkCheck.run(cfg);
    expect(r.status).toBe('ok');
    expect(calls).toBeGreaterThan(0);
  });

  it('returns ok for file sink when file is missing but parent dir is writable', async () => {
    const cfg = makeConfig({
      MCP_AUDIT_SINK: 'file',
      MCP_AUDIT_FILE: '/tmp/missing/audit.jsonl',
    });
    let call = 0;
    accessSyncImpl = () => {
      call += 1;
      if (call === 1) {
        throw new Error('ENOENT');
      }
      // Second call: parent-dir probe → succeed.
    };
    const r = await auditSinkCheck.run(cfg);
    expect(r.status).toBe('ok');
  });

  it('returns fail for file sink when neither file nor parent dir is writable', async () => {
    const cfg = makeConfig({
      MCP_AUDIT_SINK: 'file',
      MCP_AUDIT_FILE: '/nonexistent/no-perms/audit.jsonl',
    });
    accessSyncImpl = () => {
      throw new Error('EACCES: permission denied');
    };
    const r = await auditSinkCheck.run(cfg);
    expect(r.status).toBe('fail');
    expect(r.message).toContain('not writable');
    expect(r.details?.probedDir).toBe(
      path.dirname(path.resolve('/nonexistent/no-perms/audit.jsonl')),
    );
  });

  it('uses default audit file path when MCP_AUDIT_FILE is unset', async () => {
    const cfg = makeConfig({ MCP_AUDIT_SINK: 'file' });
    accessSyncImpl = () => undefined;
    const r = await auditSinkCheck.run(cfg);
    expect(r.status).toBe('ok');
    expect(r.details?.file).toBe('./discord-mcp-audit.jsonl');
  });
});
