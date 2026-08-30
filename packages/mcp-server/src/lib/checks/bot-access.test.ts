import { loadConfig } from '@discord-mcp/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { botAccessPreflightCheck } from './bot-access.js';

const GUILD_ID = '111122223333444455';
const CHANNEL_ID = '111122223333444466';
const BOT_ID = '999988887777666601';
const ROLE_ID = '999988887777666602';
const TOKEN = `Bot ${'t'.repeat(60)}`;

const originalBase = process.env.DISCORD_API_BASE_URL;

afterEach(() => {
  if (originalBase === undefined) delete process.env.DISCORD_API_BASE_URL;
  else process.env.DISCORD_API_BASE_URL = originalBase;
});

function config() {
  return loadConfig({
    DISCORD_TOKEN: TOKEN,
    DISCORD_EXPECTED_BOT_ID: BOT_ID,
    ALLOWED_GUILDS: GUILD_ID,
  });
}

function fetcherFor(
  responses: Record<string, { status: number; body?: unknown }>,
  calls: string[],
  authorizationHeaders: string[] = [],
): typeof fetch {
  return (async (input, init) => {
    expect(init?.redirect).toBe('error');
    const url = String(input);
    const path = new URL(url).pathname;
    calls.push(path);
    authorizationHeaders.push(new Headers(init?.headers).get('authorization') ?? '');
    const response = responses[path] ?? { status: 404 };
    return new Response(response.body === undefined ? '' : JSON.stringify(response.body), {
      status: response.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

describe('botAccessPreflightCheck', () => {
  it('returns identity, permission, intent, and tool evidence for one guild', async () => {
    const calls: string[] = [];
    const authorizationHeaders: string[] = [];
    const result = await botAccessPreflightCheck({
      config: config(),
      guildId: GUILD_ID,
      channelId: CHANNEL_ID,
      fetcher: fetcherFor(
        {
          '/api/v10/users/@me': {
            status: 200,
            body: { id: BOT_ID, username: 'test-bot', bot: true },
          },
          '/api/v10/applications/@me': {
            status: 200,
            body: {
              id: BOT_ID,
              bot: { id: BOT_ID },
              flags_new: String((1n << 14n) | (1n << 18n)),
            },
          },
          [`/api/v10/guilds/${GUILD_ID}`]: {
            status: 200,
            body: { id: GUILD_ID, owner_id: '999988887777666699' },
          },
          [`/api/v10/guilds/${GUILD_ID}/members/${BOT_ID}`]: {
            status: 200,
            body: { user: { id: BOT_ID }, roles: [ROLE_ID] },
          },
          [`/api/v10/guilds/${GUILD_ID}/roles`]: {
            status: 200,
            body: [
              { id: GUILD_ID, name: '@everyone', position: 0, permissions: '1024', managed: false },
              {
                id: ROLE_ID,
                name: 'Bot',
                position: 5,
                permissions: String((1n << 4n) | (1n << 11n) | (1n << 13n) | (1n << 28n)),
                managed: false,
              },
            ],
          },
          [`/api/v10/channels/${CHANNEL_ID}`]: {
            status: 200,
            body: {
              id: CHANNEL_ID,
              guild_id: GUILD_ID,
              type: 0,
              permission_overwrites: [],
            },
          },
        },
        calls,
        authorizationHeaders,
      ),
    });

    expect(result.id).toBe('bot-access');
    expect(result.status).toBe('warn');
    expect(result.details).toMatchObject({
      bot_id: BOT_ID,
      application_id: BOT_ID,
      tool_access_scope: 'catalogued_subset',
      tool_access_catalogued_count: expect.any(Number),
      guild_id: GUILD_ID,
      identity_locked: true,
      identity_match: true,
      guild_member: true,
      channel_id: CHANNEL_ID,
      intents: {
        GUILD_MEMBERS: { application: 'approved', runtime: 'not_configured' },
        MESSAGE_CONTENT: { application: 'approved', runtime: 'not_configured' },
      },
    });
    const toolAccess = result.details?.tool_access as Array<{
      tool_name: string;
      status: string;
    }>;
    expect(toolAccess.find((entry) => entry.tool_name === 'webhooks_execute')?.status).toBe(
      'opaque_required',
    );
    expect(toolAccess.find((entry) => entry.tool_name === 'app_emojis_create')?.status).toBe(
      'ready',
    );
    expect(toolAccess.find((entry) => entry.tool_name === 'messages_send')?.status).toBe('ready');
    expect(toolAccess.find((entry) => entry.tool_name === 'members_modify')?.status).toBe(
      'conditional',
    );
    expect(toolAccess.find((entry) => entry.tool_name === 'users_create_dm')?.status).toBe('ready');
    expect(toolAccess.find((entry) => entry.tool_name === 'guild_blueprint_apply')?.status).toBe(
      'delegated_required',
    );
    expect(
      toolAccess.find((entry) => entry.tool_name === 'commands_edit_command_permissions')?.status,
    ).toBe('bearer_required');
    expect(calls.every((call) => !call.includes(TOKEN))).toBe(true);
    expect(authorizationHeaders.length).toBeGreaterThan(0);
    expect(authorizationHeaders.every((value) => value === TOKEN)).toBe(true);
  });

  it('reports consent-required DM execution separately from identity readiness', async () => {
    const result = await botAccessPreflightCheck({
      config: loadConfig({
        DISCORD_TOKEN: TOKEN,
        DISCORD_EXPECTED_BOT_ID: BOT_ID,
        MCP_DM_CONSENT_MODE: 'require',
      }),
      guildId: GUILD_ID,
      fetcher: fetcherFor(
        {
          '/api/v10/users/@me': { status: 200, body: { id: BOT_ID, bot: true } },
          '/api/v10/applications/@me': {
            status: 200,
            body: { id: BOT_ID, bot: { id: BOT_ID } },
          },
          [`/api/v10/guilds/${GUILD_ID}`]: { status: 200, body: { id: GUILD_ID } },
          [`/api/v10/guilds/${GUILD_ID}/members/${BOT_ID}`]: {
            status: 200,
            body: { user: { id: BOT_ID }, roles: [ROLE_ID] },
          },
          [`/api/v10/guilds/${GUILD_ID}/roles`]: {
            status: 200,
            body: [
              { id: GUILD_ID, name: '@everyone', position: 0, permissions: '0', managed: false },
              { id: ROLE_ID, name: 'Bot', position: 5, permissions: '0', managed: false },
            ],
          },
        },
        [],
      ),
    });
    const toolAccess = result.details?.tool_access as Array<{
      tool_name: string;
      status: string;
    }>;
    expect(toolAccess.find((entry) => entry.tool_name === 'users_create_dm')?.status).toBe(
      'consent_required',
    );
  });

  it('fails closed on a mismatched identity without echoing the token', async () => {
    const result = await botAccessPreflightCheck({
      config: config(),
      fetcher: fetcherFor(
        {
          '/api/v10/users/@me': {
            status: 200,
            body: { id: '999988887777666699', username: 'other-bot', bot: true },
          },
        },
        [],
      ),
    });

    expect(result.status).toBe('fail');
    expect(result.message).toContain('identity mismatch');
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it('ignores a remote API override and sends the bot credential only to Discord', async () => {
    process.env.DISCORD_API_BASE_URL = 'https://attacker.example/api/v10';
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(new URL(String(input)).origin).toBe('https://discord.com');
      expect(new Headers(init?.headers).get('authorization')).toBe(TOKEN);
      return new Response('', { status: 401 });
    });

    const result = await botAccessPreflightCheck({
      config: config(),
      fetcher: fetcher as typeof fetch,
    });

    expect(result).toMatchObject({ id: 'bot-access', status: 'fail' });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('fails closed when the application points at a different bot', async () => {
    const result = await botAccessPreflightCheck({
      config: config(),
      fetcher: fetcherFor(
        {
          '/api/v10/users/@me': {
            status: 200,
            body: { id: BOT_ID, username: 'test-bot', bot: true },
          },
          '/api/v10/applications/@me': {
            status: 200,
            body: { id: BOT_ID, bot: { id: '999988887777666699' } },
          },
        },
        [],
      ),
    });

    expect(result.status).toBe('fail');
    expect(result.message).toContain('application identity mismatch');
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it('fails closed when the application id is not the authenticated bot id', async () => {
    const result = await botAccessPreflightCheck({
      config: config(),
      fetcher: fetcherFor(
        {
          '/api/v10/users/@me': {
            status: 200,
            body: { id: BOT_ID, username: 'test-bot', bot: true },
          },
          '/api/v10/applications/@me': {
            status: 200,
            body: { id: '999988887777666699', bot: { id: BOT_ID } },
          },
        },
        [],
      ),
    });

    expect(result.status).toBe('fail');
    expect(result.message).toContain('application identity mismatch');
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it('does not claim app-scoped readiness when application bot linkage is absent', async () => {
    const noTargetConfig = loadConfig({
      DISCORD_TOKEN: TOKEN,
      DISCORD_EXPECTED_BOT_ID: BOT_ID,
    });
    const result = await botAccessPreflightCheck({
      config: noTargetConfig,
      fetcher: fetcherFor(
        {
          '/api/v10/users/@me': { status: 200, body: { id: BOT_ID, bot: true } },
          '/api/v10/applications/@me': { status: 200, body: { id: BOT_ID, flags: 0 } },
        },
        [],
      ),
    });

    expect(result.details).toMatchObject({ application_identity: 'unknown' });
    const toolAccess = result.details?.tool_access as Array<{
      tool_name: string;
      status: string;
    }>;
    expect(toolAccess.find((entry) => entry.tool_name === 'app_emojis_create')?.status).toBe(
      'identity_unlocked',
    );
  });

  it('keeps guild-scoped readiness unknown when guild verification is unavailable', async () => {
    const result = await botAccessPreflightCheck({
      config: config(),
      guildId: GUILD_ID,
      fetcher: fetcherFor(
        {
          '/api/v10/users/@me': { status: 200, body: { id: BOT_ID, bot: true } },
          '/api/v10/applications/@me': {
            status: 200,
            body: { id: BOT_ID, bot: { id: BOT_ID }, flags: 0 },
          },
          [`/api/v10/guilds/${GUILD_ID}`]: { status: 403 },
          [`/api/v10/guilds/${GUILD_ID}/members/${BOT_ID}`]: {
            status: 200,
            body: { user: { id: BOT_ID }, roles: [ROLE_ID] },
          },
          [`/api/v10/guilds/${GUILD_ID}/roles`]: {
            status: 200,
            body: [
              { id: GUILD_ID, name: '@everyone', position: 0, permissions: '1024', managed: false },
              {
                id: ROLE_ID,
                name: 'Bot',
                position: 5,
                permissions: String(1n << 11n),
                managed: false,
              },
            ],
          },
        },
        [],
      ),
    });

    expect(result.details).toMatchObject({ guild_verified: false, guild_status: 403 });
    const toolAccess = result.details?.tool_access as Array<{
      tool_name: string;
      status: string;
    }>;
    expect(toolAccess.find((entry) => entry.tool_name === 'messages_send')?.status).toBe('unknown');
  });

  it('reports identity while keeping guild access unknown when no target is available', async () => {
    const noTargetConfig = loadConfig({ DISCORD_TOKEN: TOKEN, DISCORD_EXPECTED_BOT_ID: BOT_ID });
    const result = await botAccessPreflightCheck({
      config: noTargetConfig,
      fetcher: fetcherFor(
        {
          '/api/v10/users/@me': { status: 200, body: { id: BOT_ID, bot: true } },
          '/api/v10/applications/@me': {
            status: 200,
            body: { id: BOT_ID, bot: { id: BOT_ID }, flags: 0 },
          },
        },
        [],
      ),
    });

    expect(result.status).toBe('warn');
    expect(result.message).toContain('No target guild');
    expect(result.details).toMatchObject({ guild_id: null, identity_locked: true });
  });

  it('distinguishes missing permissions and intents from an unknown target', async () => {
    const result = await botAccessPreflightCheck({
      config: config(),
      guildId: GUILD_ID,
      channelId: CHANNEL_ID,
      fetcher: fetcherFor(
        {
          '/api/v10/users/@me': { status: 200, body: { id: BOT_ID, bot: true } },
          '/api/v10/applications/@me': {
            status: 200,
            body: { id: BOT_ID, bot: { id: BOT_ID }, flags: 0 },
          },
          [`/api/v10/guilds/${GUILD_ID}`]: {
            status: 200,
            body: { id: GUILD_ID, owner_id: '999988887777666699' },
          },
          [`/api/v10/guilds/${GUILD_ID}/members/${BOT_ID}`]: {
            status: 200,
            body: { user: { id: BOT_ID }, roles: [ROLE_ID] },
          },
          [`/api/v10/guilds/${GUILD_ID}/roles`]: {
            status: 200,
            body: [
              { id: GUILD_ID, name: '@everyone', position: 0, permissions: '1024', managed: false },
              { id: ROLE_ID, name: 'Bot', position: 5, permissions: '0', managed: false },
            ],
          },
          [`/api/v10/channels/${CHANNEL_ID}`]: {
            status: 200,
            body: { id: CHANNEL_ID, guild_id: GUILD_ID, type: 0, permission_overwrites: [] },
          },
        },
        [],
      ),
    });

    const toolAccess = result.details?.tool_access as Array<{
      tool_name: string;
      status: string;
      missing_permissions?: string[];
      missing_intents?: string[];
    }>;
    expect(toolAccess.find((entry) => entry.tool_name === 'messages_send')).toMatchObject({
      status: 'missing_permissions',
      missing_permissions: ['SEND_MESSAGES'],
    });
    expect(toolAccess.find((entry) => entry.tool_name === 'members_list')).toMatchObject({
      status: 'missing_intents',
      missing_intents: ['GUILD_MEMBERS'],
    });
  });

  it('never treats application intent approval flags as runtime-enabled Gateway intents', async () => {
    const result = await botAccessPreflightCheck({
      config: config(),
      guildId: GUILD_ID,
      fetcher: fetcherFor(
        {
          '/api/v10/users/@me': { status: 200, body: { id: BOT_ID, bot: true } },
          '/api/v10/applications/@me': {
            status: 200,
            body: { id: BOT_ID, bot: { id: BOT_ID }, flags_new: String(1n << 14n) },
          },
          [`/api/v10/guilds/${GUILD_ID}`]: {
            status: 200,
            body: { id: GUILD_ID, owner_id: '999988887777666699' },
          },
          [`/api/v10/guilds/${GUILD_ID}/members/${BOT_ID}`]: {
            status: 200,
            body: { user: { id: BOT_ID }, roles: [ROLE_ID] },
          },
          [`/api/v10/guilds/${GUILD_ID}/roles`]: {
            status: 200,
            body: [
              { id: GUILD_ID, name: '@everyone', position: 0, permissions: '0', managed: false },
              { id: ROLE_ID, name: 'Bot', position: 5, permissions: '0', managed: false },
            ],
          },
        },
        [],
      ),
    });

    expect(result.details?.intents).toMatchObject({
      GUILD_MEMBERS: { application: 'approved', runtime: 'not_configured' },
    });
    const toolAccess = result.details?.tool_access as Array<{
      tool_name: string;
      status: string;
    }>;
    expect(toolAccess.find((entry) => entry.tool_name === 'members_list')?.status).toBe(
      'missing_intents',
    );
  });

  it('keeps privileged intent access unknown when application flags are absent', async () => {
    const result = await botAccessPreflightCheck({
      config: config(),
      guildId: GUILD_ID,
      fetcher: fetcherFor(
        {
          '/api/v10/users/@me': { status: 200, body: { id: BOT_ID, bot: true } },
          '/api/v10/applications/@me': {
            status: 200,
            body: { id: BOT_ID, bot: { id: BOT_ID } },
          },
          [`/api/v10/guilds/${GUILD_ID}`]: {
            status: 200,
            body: { id: GUILD_ID },
          },
          [`/api/v10/guilds/${GUILD_ID}/members/${BOT_ID}`]: {
            status: 200,
            body: { user: { id: BOT_ID }, roles: [] },
          },
          [`/api/v10/guilds/${GUILD_ID}/roles`]: {
            status: 200,
            body: [
              { id: GUILD_ID, name: '@everyone', position: 0, permissions: '0', managed: false },
            ],
          },
        },
        [],
      ),
    });

    const toolAccess = result.details?.tool_access as Array<{
      tool_name: string;
      status: string;
    }>;
    expect(toolAccess.find((entry) => entry.tool_name === 'members_list')?.status).toBe('unknown');
  });

  it('does not call a partial guild permission union denied', async () => {
    const missingRoleId = '999988887777666603';
    const result = await botAccessPreflightCheck({
      config: config(),
      guildId: GUILD_ID,
      fetcher: fetcherFor(
        {
          '/api/v10/users/@me': { status: 200, body: { id: BOT_ID, bot: true } },
          '/api/v10/applications/@me': {
            status: 200,
            body: { id: BOT_ID, bot: { id: BOT_ID }, flags: 0 },
          },
          [`/api/v10/guilds/${GUILD_ID}`]: { status: 200, body: { id: GUILD_ID } },
          [`/api/v10/guilds/${GUILD_ID}/members/${BOT_ID}`]: {
            status: 200,
            body: { user: { id: BOT_ID }, roles: [missingRoleId] },
          },
          [`/api/v10/guilds/${GUILD_ID}/roles`]: {
            status: 200,
            body: [
              { id: GUILD_ID, name: '@everyone', position: 0, permissions: '0', managed: false },
            ],
          },
        },
        [],
      ),
    });

    const toolAccess = result.details?.tool_access as Array<{
      tool_name: string;
      status: string;
      missing_permissions?: string[];
    }>;
    expect(toolAccess.find((entry) => entry.tool_name === 'events_create')).toMatchObject({
      status: 'unknown',
      missing_permissions: [],
    });
  });

  it('rejects an explicit guild outside the configured allowlist before network access', async () => {
    let calls = 0;
    const result = await botAccessPreflightCheck({
      config: config(),
      guildId: '999988887777666699',
      fetcher: (async () => {
        calls += 1;
        return new Response('', { status: 500 });
      }) as typeof fetch,
    });

    expect(result).toMatchObject({ id: 'bot-access', status: 'fail' });
    expect(result.message).toContain('outside the configured allowlist');
    expect(calls).toBe(0);
  });
});
