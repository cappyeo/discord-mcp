import type { REST } from '@discordjs/rest';
import { describe, expect, it, vi } from 'vitest';
import { verifyExpectedBotIdentity } from './identity-lock.js';

const BOT_ID = '987654321098765432';

function fakeRest(response: unknown): { rest: REST; get: ReturnType<typeof vi.fn> } {
  const get = vi.fn(async () => response);
  return { rest: { get } as unknown as REST, get };
}

describe('verifyExpectedBotIdentity', () => {
  it('does not contact Discord when the identity lock is unset', async () => {
    const { rest, get } = fakeRest({ id: BOT_ID, username: 'bot', bot: true });

    await expect(verifyExpectedBotIdentity(rest, undefined)).resolves.toBeNull();
    expect(get).not.toHaveBeenCalled();
  });

  it('accepts the expected bot and caches successful verification per REST instance', async () => {
    const { rest, get } = fakeRest({ id: BOT_ID, username: 'setup-bot', bot: true });
    const signal = new AbortController().signal;

    await expect(verifyExpectedBotIdentity(rest, BOT_ID, signal)).resolves.toEqual({
      id: BOT_ID,
      username: 'setup-bot',
    });
    await expect(verifyExpectedBotIdentity(rest, BOT_ID)).resolves.toEqual({
      id: BOT_ID,
      username: 'setup-bot',
    });
    expect(get).toHaveBeenCalledTimes(1);
    expect(get.mock.calls[0]![1]).toEqual({ signal });
  });

  it('fails closed when the token belongs to another bot', async () => {
    const { rest } = fakeRest({ id: '111122223333444455', username: 'wrong-bot', bot: true });

    await expect(verifyExpectedBotIdentity(rest, BOT_ID)).rejects.toThrow(
      `expected ${BOT_ID}, received 111122223333444455`,
    );
  });

  it('rejects a non-bot identity and does not cache a failed verification', async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce({ id: BOT_ID, username: 'user', bot: false })
      .mockResolvedValueOnce({ id: BOT_ID, username: 'bot', bot: true });
    const rest = { get } as unknown as REST;

    await expect(verifyExpectedBotIdentity(rest, BOT_ID)).rejects.toThrow('bot account');
    await expect(verifyExpectedBotIdentity(rest, BOT_ID)).resolves.toMatchObject({ id: BOT_ID });
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('does not cache a caller-cancelled identity request', async () => {
    const controller = new AbortController();
    const cancelled = new DOMException('aborted', 'AbortError');
    const get = vi
      .fn()
      .mockRejectedValueOnce(cancelled)
      .mockResolvedValueOnce({ id: BOT_ID, username: 'bot', bot: true });
    const rest = { get } as unknown as REST;

    controller.abort();
    await expect(verifyExpectedBotIdentity(rest, BOT_ID, controller.signal)).rejects.toBe(
      cancelled,
    );
    await expect(verifyExpectedBotIdentity(rest, BOT_ID)).resolves.toMatchObject({ id: BOT_ID });

    expect(get).toHaveBeenCalledTimes(2);
    expect(get.mock.calls[0]![1]).toEqual({ signal: controller.signal });
  });
});
