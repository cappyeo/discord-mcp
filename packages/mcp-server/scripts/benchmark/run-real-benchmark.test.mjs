import { describe, expect, it } from 'vitest';

import { parseBenchmarkCommand } from './run-real-benchmark.mjs';

const COMMIT = 'babe8518767270733e5442643690cac13f94e473';

describe('real benchmark command boundary', () => {
  it('parses explicit initialize and run commands without accepting credentials in argv', () => {
    expect(
      parseBenchmarkCommand([
        'initialize',
        '--expected-commit',
        COMMIT,
        '--artifact-root',
        'C:/artifacts',
        '--guild',
        '1533989004406558851',
        '--confirmation',
        'RESET_DISPOSABLE_GUILD:1533989004406558851',
      ]),
    ).toMatchObject({ command: 'initialize', guildId: '1533989004406558851' });
    expect(
      parseBenchmarkCommand([
        'migrate',
        '--expected-commit',
        COMMIT,
        '--artifact-root',
        'C:/artifacts',
        '--guild',
        '1533989004406558851',
      ]),
    ).toMatchObject({ command: 'migrate', guildId: '1533989004406558851' });
    expect(() =>
      parseBenchmarkCommand([
        'migrate',
        '--expected-commit',
        COMMIT,
        '--artifact-root',
        'C:/artifacts',
        '--guild',
        '1533989004406558851',
        '--confirmation',
        'RESET_DISPOSABLE_GUILD:1533989004406558851',
      ]),
    ).toThrow(/not valid for migrate/);
    expect(
      parseBenchmarkCommand([
        'run',
        '--expected-commit',
        COMMIT,
        '--artifact-root',
        'C:/artifacts',
        '--request',
        'Build a gaming server',
      ]),
    ).toMatchObject({ command: 'run', request: 'Build a gaming server' });
    expect(() =>
      parseBenchmarkCommand([
        'run',
        '--expected-commit',
        COMMIT,
        '--artifact-root',
        'C:/artifacts',
        '--token',
        'never-allowed',
      ]),
    ).toThrow(/unknown flag/);
  });

  it('rejects missing, duplicate, malformed, and command-specific flags', () => {
    expect(() => parseBenchmarkCommand(['run'])).toThrow(/missing/);
    expect(() =>
      parseBenchmarkCommand([
        'run',
        '--expected-commit',
        'short',
        '--artifact-root',
        'C:/artifacts',
      ]),
    ).toThrow(/Git SHA/);
    expect(() =>
      parseBenchmarkCommand([
        'run',
        '--expected-commit',
        COMMIT,
        '--expected-commit',
        COMMIT,
        '--artifact-root',
        'C:/artifacts',
      ]),
    ).toThrow(/duplicate/);
    expect(() =>
      parseBenchmarkCommand([
        'run',
        '--expected-commit',
        COMMIT,
        '--artifact-root',
        'C:/artifacts',
        '--guild',
        '1533989004406558851',
      ]),
    ).toThrow(/only valid for initialize/);
  });
});
