/**
 * Unit tests for the readline prompt helpers - Plan 9 Phase D.
 *
 * `readline.createInterface` is mocked at the module level so we can
 * stub the `question()` method per test. Each test sets `mockAnswer` to
 * the next return value before calling the helper.
 *
 * `isInteractive()` is exercised by overriding `process.stdin.isTTY` and
 * `process.stdout.isTTY` directly.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let mockAnswer = '';
const closeMock = vi.fn();
const questionMock = vi.fn(async (_prompt: string): Promise<string> => mockAnswer);

vi.mock('node:readline/promises', () => ({
  createInterface: vi.fn(() => ({
    question: questionMock,
    close: closeMock,
  })),
}));

const { ask, askChoice, askYesNo, isInteractive } = await import('./prompt.js');

const originalStdinTTY = process.stdin.isTTY;
const originalStdoutTTY = process.stdout.isTTY;

beforeEach(() => {
  mockAnswer = '';
  questionMock.mockClear();
  closeMock.mockClear();
});

afterEach(() => {
  Object.defineProperty(process.stdin, 'isTTY', {
    value: originalStdinTTY,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(process.stdout, 'isTTY', {
    value: originalStdoutTTY,
    configurable: true,
    writable: true,
  });
});

function setTTY(stdin: boolean, stdout: boolean): void {
  Object.defineProperty(process.stdin, 'isTTY', {
    value: stdin,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(process.stdout, 'isTTY', {
    value: stdout,
    configurable: true,
    writable: true,
  });
}

describe('isInteractive', () => {
  it('returns true when both stdin and stdout are TTYs', () => {
    setTTY(true, true);
    expect(isInteractive()).toBe(true);
  });

  it('returns false when stdin is not a TTY', () => {
    setTTY(false, true);
    expect(isInteractive()).toBe(false);
  });

  it('returns false when stdout is not a TTY', () => {
    setTTY(true, false);
    expect(isInteractive()).toBe(false);
  });

  it('returns false when neither is a TTY', () => {
    setTTY(false, false);
    expect(isInteractive()).toBe(false);
  });

  it('returns false when isTTY is undefined', () => {
    Object.defineProperty(process.stdin, 'isTTY', {
      value: undefined,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(process.stdout, 'isTTY', {
      value: undefined,
      configurable: true,
      writable: true,
    });
    expect(isInteractive()).toBe(false);
  });
});

describe('ask', () => {
  it('returns trimmed user input when non-empty', async () => {
    mockAnswer = '  hello world  ';
    const result = await ask('say hi');
    expect(result).toBe('hello world');
    expect(closeMock).toHaveBeenCalled();
  });

  it('returns the default when input is empty and a default is provided', async () => {
    mockAnswer = '';
    const result = await ask('your name', 'anonymous');
    expect(result).toBe('anonymous');
  });

  it('returns the default when input is whitespace-only and a default is provided', async () => {
    mockAnswer = '   ';
    const result = await ask('your name', 'anon');
    expect(result).toBe('anon');
  });

  it('returns empty string when input empty and no default', async () => {
    mockAnswer = '';
    const result = await ask('whatever');
    expect(result).toBe('');
  });

  it('renders the default value in the prompt label', async () => {
    mockAnswer = 'x';
    await ask('pick', 'foo');
    expect(questionMock).toHaveBeenCalledWith('pick [foo]: ');
  });

  it('renders just the question when no default is provided', async () => {
    mockAnswer = 'x';
    await ask('pick');
    expect(questionMock).toHaveBeenCalledWith('pick: ');
  });

  it('closes the readline interface even when question throws', async () => {
    questionMock.mockRejectedValueOnce(new Error('boom'));
    await expect(ask('q')).rejects.toThrow('boom');
    expect(closeMock).toHaveBeenCalled();
  });
});

describe('askYesNo', () => {
  it('returns true for "y"', async () => {
    mockAnswer = 'y';
    expect(await askYesNo('continue?', false)).toBe(true);
  });

  it('returns true for "yes"', async () => {
    mockAnswer = 'yes';
    expect(await askYesNo('continue?', false)).toBe(true);
  });

  it('returns true for "Y" (case-insensitive)', async () => {
    mockAnswer = 'Y';
    expect(await askYesNo('continue?', false)).toBe(true);
  });

  it('returns false for "n"', async () => {
    mockAnswer = 'n';
    expect(await askYesNo('continue?', true)).toBe(false);
  });

  it('returns the default when input is empty (defaultYes=true)', async () => {
    mockAnswer = '';
    expect(await askYesNo('continue?', true)).toBe(true);
  });

  it('returns the default when input is empty (defaultYes=false)', async () => {
    mockAnswer = '';
    expect(await askYesNo('continue?', false)).toBe(false);
  });

  it('renders (Y/n) when defaultYes=true', async () => {
    mockAnswer = 'y';
    await askYesNo('continue?', true);
    expect(questionMock).toHaveBeenCalledWith('continue? (Y/n) [y]: ');
  });

  it('renders (y/N) when defaultYes=false', async () => {
    mockAnswer = 'y';
    await askYesNo('continue?', false);
    expect(questionMock).toHaveBeenCalledWith('continue? (y/N) [n]: ');
  });
});

describe('askChoice', () => {
  it('returns the choice for a valid 1-based index', async () => {
    mockAnswer = '2';
    const result = await askChoice('pick', ['a', 'b', 'c'] as const, 0);
    expect(result).toBe('b');
  });

  it('returns the default when input is empty', async () => {
    mockAnswer = '';
    const result = await askChoice('pick', ['a', 'b', 'c'] as const, 1);
    expect(result).toBe('b');
  });

  it('clamps a too-large index to the max choice', async () => {
    mockAnswer = '99';
    const result = await askChoice('pick', ['a', 'b', 'c'] as const, 0);
    expect(result).toBe('c');
  });

  it('clamps a zero/negative input to the first choice', async () => {
    mockAnswer = '0';
    const result = await askChoice('pick', ['a', 'b', 'c'] as const, 2);
    expect(result).toBe('a');
  });

  it('falls back to default for non-numeric input', async () => {
    mockAnswer = 'banana';
    const result = await askChoice('pick', ['a', 'b', 'c'] as const, 1);
    expect(result).toBe('b');
  });

  it('renders a numbered menu with default marker', async () => {
    mockAnswer = '1';
    await askChoice('pick', ['x', 'y'] as const, 1);
    const call = questionMock.mock.calls[0]?.[0] ?? '';
    expect(call).toContain('1. x');
    expect(call).toContain('2. y (default)');
    expect(call).toContain('Choose 1-2');
  });
});
