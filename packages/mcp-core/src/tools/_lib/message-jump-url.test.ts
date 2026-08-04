import { container } from '@sapphire/pieces';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { GuildScopePolicy } from '../../middleware/guild-allowlist.js';
import { messageJumpUrl } from './message-jump-url.js';

const CHANNEL_ID = '112233445566778899';
const MESSAGE_ID = '999000999000999000';
const GUILD_ID = '999000999000999000';

describe('messageJumpUrl', () => {
  const get = vi.fn();
  const warn = vi.fn();

  beforeEach(() => {
    get.mockReset();
    warn.mockReset();
    container.rest = { get } as never;
    container.logger = { warn } as never;
  });

  it('uses a guild ID supplied by Discord without another request', async () => {
    await expect(
      messageJumpUrl({ id: MESSAGE_ID, channel_id: CHANNEL_ID, guild_id: GUILD_ID }),
    ).resolves.toBe(`https://discord.com/channels/${GUILD_ID}/${CHANNEL_ID}/${MESSAGE_ID}`);
    expect(get).not.toHaveBeenCalled();
  });

  it('resolves a missing guild ID from channel metadata', async () => {
    get.mockResolvedValue({ guild_id: GUILD_ID });

    await expect(messageJumpUrl({ id: MESSAGE_ID, channel_id: CHANNEL_ID })).resolves.toBe(
      `https://discord.com/channels/${GUILD_ID}/${CHANNEL_ID}/${MESSAGE_ID}`,
    );
    expect(get).toHaveBeenCalledOnce();
  });

  it('reuses the allowlist channel lookup when building a canonical jump link', async () => {
    get.mockResolvedValue({ guild_id: GUILD_ID });
    const rest = { get } as never;
    container.rest = rest;
    const policy = new GuildScopePolicy(new Set([GUILD_ID]), rest);

    await policy.authorizeTool(
      'messages_send',
      { channel_id: CHANNEL_ID },
      { inputSchema: { channel_id: z.string() } },
    );
    await expect(messageJumpUrl({ id: MESSAGE_ID, channel_id: CHANNEL_ID })).resolves.toBe(
      `https://discord.com/channels/${GUILD_ID}/${CHANNEL_ID}/${MESSAGE_ID}`,
    );

    expect(get).toHaveBeenCalledOnce();
  });

  it('reuses a resolved channel for later messages in the same channel', async () => {
    get.mockResolvedValue({ guild_id: GUILD_ID });

    await messageJumpUrl({ id: MESSAGE_ID, channel_id: CHANNEL_ID });
    await messageJumpUrl({ id: '888000999000999000', channel_id: CHANNEL_ID });

    expect(get).toHaveBeenCalledOnce();
  });

  it('falls back without failing an already-sent message when lookup is unavailable', async () => {
    const error = new Error('temporary network failure');
    get.mockRejectedValue(error);

    await expect(messageJumpUrl({ id: MESSAGE_ID, channel_id: CHANNEL_ID })).resolves.toBe(
      `https://discord.com/channels/@me/${CHANNEL_ID}/${MESSAGE_ID}`,
    );
    expect(warn).toHaveBeenCalledWith(
      { err: error, channel_id: CHANNEL_ID, message_id: MESSAGE_ID },
      'Could not resolve guild-aware message jump URL',
    );
  });

  it('does not retain a failed lookup in the shared cache', async () => {
    get.mockRejectedValueOnce(new Error('temporary network failure'));
    get.mockResolvedValueOnce({ guild_id: GUILD_ID });

    await expect(messageJumpUrl({ id: MESSAGE_ID, channel_id: CHANNEL_ID })).resolves.toBe(
      `https://discord.com/channels/@me/${CHANNEL_ID}/${MESSAGE_ID}`,
    );
    await expect(messageJumpUrl({ id: MESSAGE_ID, channel_id: CHANNEL_ID })).resolves.toBe(
      `https://discord.com/channels/${GUILD_ID}/${CHANNEL_ID}/${MESSAGE_ID}`,
    );

    expect(get).toHaveBeenCalledTimes(2);
  });
});
