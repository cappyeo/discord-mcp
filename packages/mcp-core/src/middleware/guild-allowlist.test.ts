import type { REST } from '@discordjs/rest';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  BotScopeUnresolvedError,
  GuildNotAllowedError,
  GuildScopeUnresolvedError,
} from '../errors/client.js';
import {
  BOT_SCOPED_TOOLS,
  GUILD_SCOPE_BLOCKED_TOOLS,
  GuildScopePolicy,
  hasVerifiableGuildScope,
  isToolVisibleWithGuildAllowlist,
  parseGuildAllowlist,
} from './guild-allowlist.js';

const ALLOWED = '111122223333444455';
const DENIED = '999000999000999000';
const BOT_ID = '987654321098765432';

function fakeRest(get: ReturnType<typeof vi.fn>): REST {
  return { get } as unknown as REST;
}

describe('guild allowlist policy', () => {
  it('is a zero-overhead no-op when unset', async () => {
    const get = vi.fn();
    const policy = new GuildScopePolicy(parseGuildAllowlist(undefined), fakeRest(get));
    await policy.authorizeTool(
      'messages_send',
      { channel_id: '222233334444555566' },
      { inputSchema: { channel_id: z.string() } },
    );
    expect(policy.enabled).toBe(false);
    expect(get).not.toHaveBeenCalled();
  });

  it('checks a direct guild with no Discord lookup', async () => {
    const get = vi.fn();
    const policy = new GuildScopePolicy(new Set([ALLOWED]), fakeRest(get));
    await policy.authorizeTool(
      'guild_get',
      { guild_id: ALLOWED },
      { inputSchema: { guild_id: z.string() } },
    );
    await expect(
      policy.authorizeTool(
        'guild_get',
        { guild_id: DENIED },
        { inputSchema: { guild_id: z.string() } },
      ),
    ).rejects.toBeInstanceOf(GuildNotAllowedError);
    expect(get).not.toHaveBeenCalled();
  });

  it('requires an optional declared guild instead of broadening to a global query', async () => {
    const policy = new GuildScopePolicy(new Set([ALLOWED]), fakeRest(vi.fn()));
    await expect(
      policy.authorizeTool(
        'entitlements_list',
        { application_id: '222233334444555566' },
        { inputSchema: { application_id: z.string(), guild_id: z.string().optional() } },
      ),
    ).rejects.toBeInstanceOf(GuildScopeUnresolvedError);
  });

  it('resolves channel scope once and reuses the cached guild', async () => {
    const get = vi.fn().mockResolvedValue({ guild_id: ALLOWED });
    const policy = new GuildScopePolicy(new Set([ALLOWED]), fakeRest(get));
    const schema = { inputSchema: { channel_id: z.string() } };

    await policy.authorizeTool('messages_send', { channel_id: '222233334444555566' }, schema);
    await policy.authorizeTool('messages_send', { channel_id: '222233334444555566' }, schema);

    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith('/channels/222233334444555566');
  });

  it('bounds the resource cache instead of retaining unlimited caller IDs', async () => {
    const get = vi.fn().mockResolvedValue({ guild_id: ALLOWED });
    const policy = new GuildScopePolicy(new Set([ALLOWED]), fakeRest(get));
    const schema = { inputSchema: { channel_id: z.string() } };
    const first = '200000000000000000';

    for (let index = 0; index <= 1_024; index += 1) {
      await policy.authorizeTool(
        'messages_send',
        { channel_id: String(200000000000000000n + BigInt(index)) },
        schema,
      );
    }
    await policy.authorizeTool('messages_send', { channel_id: first }, schema);

    expect(get).toHaveBeenCalledTimes(1_026);
  });

  it('rejects a channel in a denied guild before the write can run', async () => {
    const policy = new GuildScopePolicy(
      new Set([ALLOWED]),
      fakeRest(vi.fn().mockResolvedValue({ guild_id: DENIED })),
    );
    await expect(
      policy.authorizeTool(
        'messages_send',
        { channel_id: '222233334444555566' },
        { inputSchema: { channel_id: z.string() } },
      ),
    ).rejects.toBeInstanceOf(GuildNotAllowedError);
  });

  it('resolves webhook and invite guilds, including token-auth webhooks', async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce({ guild_id: ALLOWED })
      .mockResolvedValueOnce({ guild: { id: ALLOWED } });
    const policy = new GuildScopePolicy(new Set([ALLOWED]), fakeRest(get));

    await policy.authorizeTool(
      'webhooks_execute',
      { webhook_id: '222233334444555566', token: 'secret' },
      { inputSchema: { webhook_id: z.string(), token: z.string() } },
    );
    await policy.authorizeTool(
      'invites_delete',
      { code: 'invite-code' },
      { inputSchema: { code: z.string() } },
    );

    expect(get).toHaveBeenNthCalledWith(1, '/webhooks/222233334444555566/secret', {
      auth: false,
    });
    expect(get).toHaveBeenNthCalledWith(2, '/invites/invite-code');
  });

  it('allows a global sticker but checks a guild sticker', async () => {
    const get = vi.fn().mockResolvedValueOnce({}).mockResolvedValueOnce({ guild_id: DENIED });
    const policy = new GuildScopePolicy(new Set([ALLOWED]), fakeRest(get));
    const schema = { inputSchema: { sticker_id: z.string() } };

    await policy.authorizeTool('stickers_get', { sticker_id: '222233334444555566' }, schema);
    await expect(
      policy.authorizeTool('stickers_get', { sticker_id: '333344445555666677' }, schema),
    ).rejects.toBeInstanceOf(GuildNotAllowedError);
  });

  it('hides and blocks every unprovable global write and interaction route', async () => {
    expect(GUILD_SCOPE_BLOCKED_TOOLS.size).toBe(22);
    const policy = new GuildScopePolicy(new Set([ALLOWED]), fakeRest(vi.fn()));
    for (const tool of GUILD_SCOPE_BLOCKED_TOOLS) {
      expect(isToolVisibleWithGuildAllowlist(tool, true)).toBe(false);
      const expectedError = BOT_SCOPED_TOOLS.has(tool)
        ? BotScopeUnresolvedError
        : GuildScopeUnresolvedError;
      await expect(policy.authorizeTool(tool, {}, { inputSchema: {} })).rejects.toBeInstanceOf(
        expectedError,
      );
    }
    expect(isToolVisibleWithGuildAllowlist('users_get_current', true)).toBe(true);
  });

  it('allows application-emoji writes only for the locked bot application', async () => {
    expect(isToolVisibleWithGuildAllowlist('app_emojis_create', true, BOT_ID)).toBe(true);
    expect(isToolVisibleWithGuildAllowlist('app_emojis_modify', true, BOT_ID)).toBe(true);
    expect(isToolVisibleWithGuildAllowlist('app_emojis_delete', true, BOT_ID)).toBe(true);

    const policy = new GuildScopePolicy(new Set([ALLOWED]), fakeRest(vi.fn()), BOT_ID);
    const schema = { inputSchema: { application_id: z.string().optional() } };
    await policy.authorizeTool('app_emojis_create', {}, schema);
    await policy.authorizeTool('app_emojis_modify', { application_id: BOT_ID }, schema);
    await expect(
      policy.authorizeTool('app_emojis_create', { application_id: DENIED }, schema),
    ).rejects.toBeInstanceOf(BotScopeUnresolvedError);

    const unlockedGuildPolicy = new GuildScopePolicy(null, fakeRest(vi.fn()), BOT_ID);
    await expect(
      unlockedGuildPolicy.authorizeTool('app_emojis_create', { application_id: DENIED }, schema),
    ).rejects.toBeInstanceOf(BotScopeUnresolvedError);
  });

  it('keeps bot-scoped emoji writes unavailable without an identity lock', async () => {
    expect(isToolVisibleWithGuildAllowlist('app_emojis_create', true)).toBe(false);
    const policy = new GuildScopePolicy(new Set([ALLOWED]), fakeRest(vi.fn()));
    await expect(
      policy.authorizeTool(
        'app_emojis_create',
        {},
        { inputSchema: { application_id: z.string() } },
      ),
    ).rejects.toBeInstanceOf(BotScopeUnresolvedError);
  });

  it('detects a newly added write route that lacks a verifiable guild seam', () => {
    expect(hasVerifiableGuildScope('messages_send', { channel_id: z.string() })).toBe(true);
    expect(hasVerifiableGuildScope('future_global_write', { value: z.string() })).toBe(false);
  });

  it('guards guild, voice, and channel subscriptions while leaving static resources safe', async () => {
    const get = vi.fn().mockResolvedValue({ guild_id: ALLOWED });
    const policy = new GuildScopePolicy(new Set([ALLOWED]), fakeRest(get));

    await policy.authorizeSubscription(`discord://guild/${ALLOWED}/info`);
    await policy.authorizeSubscription(`discord://voice/${ALLOWED}/state`);
    await policy.authorizeSubscription('discord://channel/222233334444555566/typing');
    await policy.authorizeSubscription('discord://components-v2/schema');
    await expect(
      policy.authorizeSubscription(`discord://guild/${DENIED}/info`),
    ).rejects.toBeInstanceOf(GuildNotAllowedError);
    await expect(policy.authorizeSubscription('discord://unknown/value')).rejects.toBeInstanceOf(
      GuildScopeUnresolvedError,
    );
  });
});
