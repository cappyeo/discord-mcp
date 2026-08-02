import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const initAction = vi.fn(async (_options: unknown) => undefined);
const ask = vi.fn(async () => 'interactive-bot');
let interactive = false;

vi.mock('./init.js', () => ({ initAction }));
vi.mock('../lib/prompt.js', () => ({
  ask,
  isInteractive: () => interactive,
}));

const { setupAction } = await import('./setup.js');

const originalExitCode = process.exitCode;
let stdoutWrites: string[];

beforeEach(() => {
  interactive = false;
  stdoutWrites = [];
  initAction.mockClear();
  ask.mockClear();
  process.exitCode = 0;
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown): boolean => {
    stdoutWrites.push(typeof chunk === 'string' ? chunk : String(chunk));
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = originalExitCode;
});

describe('setupAction', () => {
  it('requires an explicit profile in non-interactive mode', async () => {
    await setupAction({ json: true });

    expect(process.exitCode).toBe(2);
    expect(initAction).not.toHaveBeenCalled();
    expect(JSON.parse(stdoutWrites.join('')).summary).toContain('--profile');
  });

  it('routes the safe guided defaults into init without accepting a token argument', async () => {
    await setupAction({
      profile: 'devbot',
      client: 'codex',
      json: true,
      profileDirectory: 'C:/profiles',
    });

    expect(initAction).toHaveBeenCalledWith({
      client: 'codex',
      discoverGuilds: true,
      json: true,
      profile: { name: 'devbot', directory: 'C:/profiles' },
      toolSurface: 'progressive',
    });
    expect(initAction.mock.calls[0]?.[0]).not.toHaveProperty('token');
  });

  it('prompts for a profile name only in interactive mode', async () => {
    interactive = true;

    await setupAction({ client: 'generic' });

    expect(ask).toHaveBeenCalledWith('Profile name', 'default');
    expect(initAction).toHaveBeenCalledWith(
      expect.objectContaining({ profile: { name: 'interactive-bot' } }),
    );
  });
});
