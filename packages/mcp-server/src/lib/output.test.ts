import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type CommandResult, emitResult } from './output.js';

const originalIsTTY = process.stdout.isTTY;
const originalExitCode = process.exitCode;

const writes: string[] = [];

beforeEach(() => {
  writes.length = 0;
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown): boolean => {
    writes.push(typeof chunk === 'string' ? chunk : String(chunk));
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(process.stdout, 'isTTY', {
    value: originalIsTTY,
    configurable: true,
    writable: true,
  });
  process.exitCode = originalExitCode;
});

function lastWrite(): string {
  if (writes.length === 0) {
    throw new Error('emitResult did not write to stdout');
  }
  return writes[0] ?? '';
}

function setTTY(value: boolean): void {
  Object.defineProperty(process.stdout, 'isTTY', {
    value,
    configurable: true,
    writable: true,
  });
}

// CSI byte = ESC + '['. We assert presence/absence by substring instead
// of a regex (biome's noControlCharactersInRegex disallows \x1b literals).
const CSI_BYTE = '\x1b[';
function hasAnsi(s: string): boolean {
  return s.includes(CSI_BYTE);
}

describe('emitResult - JSON mode', () => {
  it('produces parseable JSON for an ok result', () => {
    const result: CommandResult = {
      ok: true,
      summary: 'all green',
      exitCode: 0,
    };
    emitResult(result, true);

    const out = lastWrite();
    const parsed = JSON.parse(out);
    expect(parsed).toEqual(result);
    expect(out.endsWith('\n')).toBe(true);
  });

  it('strips color codes in JSON mode even on TTY', () => {
    setTTY(true);
    const result: CommandResult = {
      ok: false,
      summary: 'nope',
      errors: ['boom'],
      exitCode: 2,
    };
    emitResult(result, true);

    const out = lastWrite();
    expect(hasAnsi(out)).toBe(false);
    // Still parseable.
    expect(() => JSON.parse(out)).not.toThrow();
  });

  it('echoes data payload', () => {
    const result: CommandResult = {
      ok: true,
      summary: 'done',
      data: { tools: 192, transport: 'stdio' },
      exitCode: 0,
    };
    emitResult(result, true);

    const parsed = JSON.parse(lastWrite()) as CommandResult;
    expect(parsed.data).toEqual({ tools: 192, transport: 'stdio' });
  });
});

describe('emitResult - pretty TTY mode', () => {
  it('includes color codes when stdout.isTTY is true', () => {
    setTTY(true);
    const result: CommandResult = {
      ok: true,
      summary: 'all green',
      exitCode: 0,
    };
    emitResult(result, false);

    const out = lastWrite();
    expect(hasAnsi(out)).toBe(true);
    expect(out).toContain('OK');
    expect(out).toContain('all green');
  });

  it('omits color codes when stdout.isTTY is false', () => {
    setTTY(false);
    const result: CommandResult = {
      ok: true,
      summary: 'all green',
      exitCode: 0,
    };
    emitResult(result, false);

    const out = lastWrite();
    expect(hasAnsi(out)).toBe(false);
    expect(out).toContain('OK all green');
  });

  it('formats warnings as bullet list', () => {
    setTTY(false);
    const result: CommandResult = {
      ok: false,
      summary: '2 warnings',
      warnings: ['no token', 'gateway disabled'],
      exitCode: 1,
    };
    emitResult(result, false);

    const out = lastWrite();
    expect(out).toContain('Warnings:');
    expect(out).toContain('* no token');
    expect(out).toContain('* gateway disabled');
    expect(out).toContain('WARN');
  });

  it('formats errors as bullet list', () => {
    setTTY(false);
    const result: CommandResult = {
      ok: false,
      summary: 'check failed',
      errors: ['bad token', 'rate limited'],
      exitCode: 2,
    };
    emitResult(result, false);

    const out = lastWrite();
    expect(out).toContain('Errors:');
    expect(out).toContain('* bad token');
    expect(out).toContain('* rate limited');
    expect(out).toContain('FAIL');
  });

  it('renders details under summary', () => {
    setTTY(false);
    const result: CommandResult = {
      ok: true,
      summary: 'doctor',
      details: ['token: ok', 'gateway: skipped'],
      exitCode: 0,
    };
    emitResult(result, false);

    const out = lastWrite();
    expect(out).toContain('token: ok');
    expect(out).toContain('gateway: skipped');
  });
});

describe('emitResult - exit code', () => {
  it('sets process.exitCode to 0 for ok', () => {
    emitResult({ ok: true, summary: 'ok', exitCode: 0 }, true);
    expect(process.exitCode).toBe(0);
  });

  it('sets process.exitCode to 1 for warn', () => {
    emitResult({ ok: false, summary: 'warn', warnings: ['x'], exitCode: 1 }, true);
    expect(process.exitCode).toBe(1);
  });

  it('sets process.exitCode to 2 for error', () => {
    emitResult({ ok: false, summary: 'fail', errors: ['x'], exitCode: 2 }, true);
    expect(process.exitCode).toBe(2);
  });

  it('does not call process.exit', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit called with ${code}`);
    }) as never);
    try {
      emitResult({ ok: false, summary: 'x', errors: ['x'], exitCode: 2 }, false);
      expect(exitSpy).not.toHaveBeenCalled();
    } finally {
      exitSpy.mockRestore();
    }
  });
});
