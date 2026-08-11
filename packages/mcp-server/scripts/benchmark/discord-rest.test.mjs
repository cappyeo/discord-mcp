import { describe, expect, it, vi } from 'vitest';
import { createDiscordRestClient, DiscordRestError, readDiscordSnapshot } from './discord-rest.mjs';

const GUILD_ID = '999000999000999000';
const BOT_ID = '888000888000888000';
const BOT_ROLE_ID = '777000777000777000';
const TOKEN = 'benchmark-secret-value-that-must-never-escape';

function response(value, status = 200, headers = {}) {
  return new Response(value === null ? null : JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function basePayload(pathname) {
  switch (pathname) {
    case '/api/v10/users/@me':
      return { id: BOT_ID, bot: true, username: 'BenchmarkBot' };
    case `/api/v10/guilds/${GUILD_ID}`:
      return { id: GUILD_ID, name: 'Benchmark', features: [] };
    case `/api/v10/guilds/${GUILD_ID}/members/${BOT_ID}`:
      return { user: { id: BOT_ID }, roles: [BOT_ROLE_ID] };
    case `/api/v10/guilds/${GUILD_ID}/roles`:
      return [
        { id: GUILD_ID, name: '@everyone', position: 0, permissions: '0', managed: false },
        { id: BOT_ROLE_ID, name: 'BenchmarkBot', position: 10, permissions: '8', managed: true },
      ];
    case `/api/v10/guilds/${GUILD_ID}/channels`:
    case `/api/v10/guilds/${GUILD_ID}/auto-moderation/rules`:
      return [];
    default:
      throw new Error(`Unexpected request: ${pathname}`);
  }
}

function fetchForBase() {
  return vi.fn(async (input) => {
    const url = new URL(String(input));
    return response(basePayload(url.pathname));
  });
}

describe('Discord benchmark REST snapshot', () => {
  it('never sends the bot credential to an arbitrary API host', () => {
    expect(() =>
      createDiscordRestClient({
        token: TOKEN,
        fetchImpl: vi.fn(),
        apiBaseUrl: 'https://attacker.example/api/v10',
      }),
    ).toThrow('official Discord');
  });

  it('rejects an absolute URL disguised as an API path before sending credentials', async () => {
    const fetchImpl = vi.fn();
    const rest = createDiscordRestClient({ token: TOKEN, fetchImpl });

    await expect(rest.get('/https://attacker.example/collect')).rejects.toThrow(/escaped/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects timeout values outside the bounded integer range', () => {
    for (const timeoutMs of [
      99,
      120_001,
      15_000.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      '15000',
    ]) {
      expect(() =>
        createDiscordRestClient({
          token: TOKEN,
          fetchImpl: vi.fn(),
          timeoutMs,
        }),
      ).toThrow('timeoutMs must be an integer from 100 to 120000');
    }
  });

  it('reads the independent literal snapshot without returning the bot token', async () => {
    const fetchImpl = fetchForBase();
    const rest = createDiscordRestClient({
      token: TOKEN,
      fetchImpl,
      apiBaseUrl: 'https://discord.com/api/v10',
    });
    const snapshot = await readDiscordSnapshot(rest, {
      guildId: GUILD_ID,
      botId: BOT_ID,
    });

    expect(snapshot.guild.id).toBe(GUILD_ID);
    expect(snapshot.bot.user.id).toBe(BOT_ID);
    expect(snapshot.roles).toHaveLength(2);
    expect(JSON.stringify(snapshot)).not.toContain(TOKEN);
    expect(fetchImpl).toHaveBeenCalledTimes(6);
    for (const [, init] of fetchImpl.mock.calls) {
      expect(init.headers.authorization).toBe(`Bot ${TOKEN}`);
    }
  });

  it('fails closed when any scoped Discord response belongs to another guild', async () => {
    const fetchImpl = vi.fn(async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/channels')) {
        return response([
          {
            id: '666000666000666000',
            guild_id: '111000111000111000',
            name: 'wrong-target',
            type: 0,
            permission_overwrites: [],
          },
        ]);
      }
      return response(basePayload(url.pathname));
    });
    const rest = createDiscordRestClient({
      token: TOKEN,
      fetchImpl,
      apiBaseUrl: 'https://discord.com/api/v10',
    });

    await expect(readDiscordSnapshot(rest, { guildId: GUILD_ID, botId: BOT_ID })).rejects.toThrow(
      'guild mismatch',
    );
  });

  it('fails closed on duplicate or malformed resource identities and permissions', async () => {
    const fetchImpl = vi.fn(async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/roles')) {
        return response([
          { id: GUILD_ID, name: '@everyone', position: 0, permissions: '0', managed: false },
          { id: GUILD_ID, name: 'duplicate', position: 1, permissions: 'not-bits', managed: false },
        ]);
      }
      return response(basePayload(url.pathname));
    });
    const rest = createDiscordRestClient({ token: TOKEN, fetchImpl });
    await expect(readDiscordSnapshot(rest, { guildId: GUILD_ID, botId: BOT_ID })).rejects.toThrow(
      /duplicate|bitfield/,
    );
  });

  it('fails closed on a malformed channel position', async () => {
    const fetchImpl = vi.fn(async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/channels')) {
        return response([
          {
            id: '666000666000666000',
            guild_id: GUILD_ID,
            name: 'malformed',
            type: 0,
            position: -1,
            permission_overwrites: [],
          },
        ]);
      }
      return response(basePayload(url.pathname));
    });
    const rest = createDiscordRestClient({ token: TOKEN, fetchImpl });

    await expect(readDiscordSnapshot(rest, { guildId: GUILD_ID, botId: BOT_ID })).rejects.toThrow(
      /channel.*position/i,
    );
  });

  it.each([
    ['creator identity', { creator_id: 'not-a-snowflake', trigger_type: 5 }, /creator_id/],
    ['trigger type', { creator_id: BOT_ID, trigger_type: 0 }, /trigger_type/],
  ])('fails closed on malformed AutoMod %s', async (_name, fields, message) => {
    const fetchImpl = vi.fn(async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/auto-moderation/rules')) {
        return response([
          {
            id: '666000666000666000',
            guild_id: GUILD_ID,
            name: 'Protected rule',
            ...fields,
          },
        ]);
      }
      return response(basePayload(url.pathname));
    });
    const rest = createDiscordRestClient({ token: TOKEN, fetchImpl });

    await expect(readDiscordSnapshot(rest, { guildId: GUILD_ID, botId: BOT_ID })).rejects.toThrow(
      message,
    );
  });

  it('accepts AutoMod trigger type 6 in a snapshot', async () => {
    const fetchImpl = vi.fn(async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/auto-moderation/rules')) {
        return response([
          {
            id: '666000666000666000',
            guild_id: GUILD_ID,
            creator_id: BOT_ID,
            trigger_type: 6,
          },
        ]);
      }
      return response(basePayload(url.pathname));
    });
    const rest = createDiscordRestClient({ token: TOKEN, fetchImpl });

    await expect(
      readDiscordSnapshot(rest, { guildId: GUILD_ID, botId: BOT_ID }),
    ).resolves.toMatchObject({
      automod_rules: [expect.objectContaining({ trigger_type: 6 })],
    });
  });

  it('reads Community state and bounded publication histories with identity checks', async () => {
    const channelId = '666000666000666000';
    const messageId = '555000555000555000';
    const fetchImpl = vi.fn(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === `/api/v10/guilds/${GUILD_ID}`) {
        return response({ id: GUILD_ID, name: 'Benchmark', features: ['COMMUNITY'] });
      }
      if (url.pathname.endsWith('/onboarding')) {
        return response({
          guild_id: GUILD_ID,
          enabled: true,
          prompts: [],
          default_channel_ids: [],
        });
      }
      if (url.pathname.endsWith('/welcome-screen')) {
        return response({ description: 'Welcome', welcome_channels: [] });
      }
      if (url.pathname === `/api/v10/guilds/${GUILD_ID}/channels`) {
        return response([
          {
            id: channelId,
            guild_id: GUILD_ID,
            name: 'welcome',
            type: 0,
            position: 0,
            permission_overwrites: [],
          },
        ]);
      }
      if (url.pathname === `/api/v10/channels/${channelId}/messages`) {
        expect(url.searchParams.get('limit')).toBe('100');
        return response([
          {
            id: messageId,
            channel_id: channelId,
            author: { id: BOT_ID },
            flags: 32_768,
          },
        ]);
      }
      return response(basePayload(url.pathname));
    });
    const rest = createDiscordRestClient({
      token: TOKEN,
      fetchImpl,
      apiBaseUrl: 'https://discord.com/api/v10',
    });

    const snapshot = await readDiscordSnapshot(rest, {
      guildId: GUILD_ID,
      botId: BOT_ID,
      messageChannelIds: [channelId],
    });

    expect(snapshot.onboarding.guild_id).toBe(GUILD_ID);
    expect(snapshot.welcome_screen.description).toBe('Welcome');
    expect(snapshot.recent_messages[channelId]).toEqual([
      expect.objectContaining({ id: messageId, channel_id: channelId }),
    ]);
    expect(snapshot.publication_history_complete[channelId]).toBe(true);
  });

  it('allows only an explicit restore read to treat a missing publication channel as gone', async () => {
    const missingChannelId = '666000666000666000';
    const fetchImpl = fetchForBase();
    const rest = createDiscordRestClient({ token: TOKEN, fetchImpl });

    await expect(
      readDiscordSnapshot(rest, {
        guildId: GUILD_ID,
        botId: BOT_ID,
        messageChannelIds: [missingChannelId],
      }),
    ).rejects.toThrow('publication channel guild mismatch');

    const snapshot = await readDiscordSnapshot(rest, {
      guildId: GUILD_ID,
      botId: BOT_ID,
      messageChannelIds: [missingChannelId],
      allowMissingMessageChannelIds: true,
    });

    expect(snapshot.recent_messages[missingChannelId]).toEqual([]);
    expect(snapshot.publication_history_complete[missingChannelId]).toBe(true);
    expect(
      fetchImpl.mock.calls.some(([input]) =>
        String(input).includes(`/channels/${missingChannelId}/messages`),
      ),
    ).toBe(false);
  });

  it('bounds concurrent message-history reads for large baseline channel sets', async () => {
    const channelIds = Array.from({ length: 9 }, (_, index) =>
      String(666_000_666_000_666_000n + BigInt(index)),
    );
    let active = 0;
    let maximumActive = 0;
    const fetchImpl = vi.fn(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === `/api/v10/guilds/${GUILD_ID}/channels`) {
        return response(
          channelIds.map((id, position) => ({
            id,
            guild_id: GUILD_ID,
            name: `channel-${position}`,
            type: 0,
            position,
            permission_overwrites: [],
          })),
        );
      }
      if (/\/api\/v10\/channels\/\d+\/messages/.test(url.pathname)) {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active -= 1;
        return response([]);
      }
      return response(basePayload(url.pathname));
    });
    const rest = createDiscordRestClient({ token: TOKEN, fetchImpl });

    await readDiscordSnapshot(rest, {
      guildId: GUILD_ID,
      botId: BOT_ID,
      messageChannelIds: channelIds,
    });

    expect(maximumActive).toBe(4);
  });

  it('retries bounded Discord 429 responses and redacts credentials from failures', async () => {
    const sleep = vi.fn(async () => undefined);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response({ retry_after: 0 }, 429))
      .mockResolvedValueOnce(response({ id: BOT_ID, bot: true }))
      .mockResolvedValueOnce(response({ message: `bad ${TOKEN}` }, 401));
    const rest = createDiscordRestClient({
      token: TOKEN,
      fetchImpl,
      apiBaseUrl: 'https://discord.com/api/v10',
      sleep,
    });

    await expect(rest.get('/users/@me')).resolves.toEqual({ id: BOT_ID, bot: true });
    expect(sleep).toHaveBeenCalledOnce();
    await expect(rest.get('/users/@me')).rejects.toSatisfy((error) => {
      expect(error).toBeInstanceOf(DiscordRestError);
      expect(error).toMatchObject({ status: 401, disposition: 'deterministic' });
      expect(String(error)).toContain('401');
      expect(String(error)).not.toContain(TOKEN);
      return true;
    });
  });

  it.each([
    ['PATCH 403', 'PATCH', 403, 'deterministic', 1],
    ['DELETE 404', 'DELETE', 404, 'ambiguous', 1],
    ['PATCH 500', 'PATCH', 500, 'ambiguous', 4],
  ])('classifies %s outcomes for restore recovery', async (_name, method, status, disposition, expectedCalls) => {
    const fetchImpl = vi.fn(async () => response({ message: 'failure' }, status));
    const sleep = vi.fn(async () => undefined);
    const rest = createDiscordRestClient({ token: TOKEN, fetchImpl, sleep });

    await expect(rest.request(method, `/guilds/${GUILD_ID}`)).rejects.toMatchObject({
      name: 'DiscordRestError',
      status,
      method,
      path: `/guilds/${GUILD_ID}`,
      disposition,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(expectedCalls);
  });

  it('sends bounded target-scoped JSON mutations with an encoded audit reason', async () => {
    const fetchImpl = vi.fn(async (_input, init) => {
      expect(init.method).toBe('PATCH');
      expect(init.headers['content-type']).toBe('application/json');
      expect(init.headers['x-audit-log-reason']).toBe('discord-mcp%20benchmark%20reset%20trial-01');
      expect(JSON.parse(init.body)).toEqual({ name: 'Benchmark' });
      return response({ id: GUILD_ID, name: 'Benchmark' });
    });
    const rest = createDiscordRestClient({ token: TOKEN, fetchImpl });

    await expect(
      rest.request('PATCH', `/guilds/${GUILD_ID}`, {
        body: { name: 'Benchmark' },
        reason: 'discord-mcp benchmark reset trial-01',
      }),
    ).resolves.toEqual({ id: GUILD_ID, name: 'Benchmark' });
  });

  it('does not retry an ambiguous POST transport failure by default', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error(`socket failed with ${TOKEN}`);
    });
    const sleep = vi.fn(async () => undefined);
    const rest = createDiscordRestClient({ token: TOKEN, fetchImpl, sleep });

    await expect(
      rest.request('POST', `/guilds/${GUILD_ID}/roles`, { body: { name: 'Canary' } }),
    ).rejects.toSatisfy((error) => {
      expect(error).toBeInstanceOf(DiscordRestError);
      expect(error).toMatchObject({ disposition: 'ambiguous', method: 'POST' });
      expect(String(error)).not.toContain(TOKEN);
      return true;
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });

  it.each([
    ['body', { retry_after: 999_999 }],
    ['header', {}, { 'retry-after': '999999' }],
  ])('caps huge 429 %s Retry-After delays', async (_source, body, headers) => {
    const sleep = vi.fn(async () => undefined);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response(body, 429, headers))
      .mockResolvedValueOnce(response({ id: BOT_ID, bot: true }));
    const rest = createDiscordRestClient({
      token: TOKEN,
      fetchImpl,
      apiBaseUrl: 'https://discord.com/api/v10',
      sleep,
    });

    await expect(rest.get('/users/@me')).resolves.toEqual({ id: BOT_ID, bot: true });
    expect(sleep).toHaveBeenCalledWith(30_000);
  });
});
