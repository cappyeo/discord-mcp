import type { REST } from '@discordjs/rest';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from './config.js';
import type { SubscriptionRegistry } from './gateway/subscription_registry.js';
import { createLogger } from './logger.js';
import { buildServer } from './server.js';

const ALLOWED = '111122223333444455';
const DENIED = '999000999000999000';
const ALLOWED_CHANNEL = '222233334444555566';
const DENIED_CHANNEL = '333344445555666677';
const BASE_ENV = {
  DISCORD_TOKEN: 'test-token-for-guild-allowlist-suite-0000000000000000',
  LOG_LEVEL: 'fatal',
  MCP_AUDIT_SINK: 'none',
} as NodeJS.ProcessEnv;

interface Harness {
  client: Client;
  subscriptions: SubscriptionRegistry;
  notifyResource: (uri: string) => Promise<void>;
  get: ReturnType<typeof vi.fn>;
  post: ReturnType<typeof vi.fn>;
}

const open: Harness[] = [];

async function connect(extraEnv: NodeJS.ProcessEnv = {}): Promise<Harness> {
  const get = vi.fn(async (route: string) => {
    if (route === '/users/@me' || route === '/users/%40me')
      return { id: '987654321098765432', bot: true };
    if (route === `/channels/${ALLOWED_CHANNEL}`) return { guild_id: ALLOWED };
    if (route === `/channels/${DENIED_CHANNEL}`) return { guild_id: DENIED };
    return {};
  });
  const post = vi.fn(async (_route: string) => ({
    id: '444455556666777788',
    channel_id: ALLOWED_CHANNEL,
    guild_id: ALLOWED,
    content: 'test',
    timestamp: '2026-08-03T00:00:00.000Z',
  }));
  const rest = { get, post } as unknown as REST;
  const config = loadConfig({ ...BASE_ENV, ...extraEnv });
  const logger = createLogger(config);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const built = await buildServer({ rest, logger, config });
  const client = new Client(
    { name: 'guild-allowlist-test', version: '0.0.0' },
    {
      capabilities: {},
    },
  );
  await Promise.all([built.server.connect(serverTransport), client.connect(clientTransport)]);
  const harness = {
    client,
    subscriptions: built.subscriptions,
    notifyResource: built.notifyResource,
    get,
    post,
  };
  open.push(harness);
  return harness;
}

afterEach(async () => {
  await Promise.all(open.splice(0).map(({ client }) => client.close()));
});

describe('ALLOWED_GUILDS server boundary', () => {
  it('preserves the full 209-tool compatibility surface when unset', async () => {
    const { client } = await connect();
    expect((await client.listTools()).tools).toHaveLength(209);
  });

  it('hides unprovable routes and advertises the remaining 176 tools', async () => {
    const { client } = await connect({ ALLOWED_GUILDS: ALLOWED });
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).toHaveLength(176);
    expect(names).not.toContain('app_emojis_list');
    expect(names).not.toContain('app_emojis_get');
    expect(names).not.toContain('interactions_create_response');
    expect(names).not.toContain('commands_create_global');
    expect(names).not.toContain('users_create_dm');
    expect(names).toContain('users_get_current');
    expect(names).toContain('users_list_current_user_guilds');
    expect(names).toContain('mcp_pipeline');
    expect(names).toContain('permissions_audit_channel');
    expect(names).toContain('permissions_explain');
    expect(client.getInstructions()).toContain('ALLOWED_GUILDS is active');
  });

  it('exposes user-scoped DM creation only with identity lock, opt-in, and consent mode', async () => {
    const { client, post } = await connect({
      ALLOWED_GUILDS: ALLOWED,
      DISCORD_EXPECTED_BOT_ID: '987654321098765432',
      MCP_ALLOW_USER_SCOPED: 'true',
      MCP_DM_CONSENT_MODE: 'require',
    });
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).toContain('users_create_dm');
    const result = await client.callTool({
      name: 'users_create_dm',
      arguments: { recipient_id: '999000999000999000' },
    });
    expect(result.structuredContent).toMatchObject({ code: 'DM_CONSENT_REQUIRED' });
    expect(post).not.toHaveBeenCalled();
  });

  it('allows a direct allowed guild and rejects a denied guild without REST traffic', async () => {
    const { client, get, post } = await connect({ ALLOWED_GUILDS: ALLOWED });
    const allowed = await client.callTool({
      name: 'guild_get_widget_image_url',
      arguments: { guild_id: ALLOWED },
    });
    expect(allowed.isError).toBe(false);

    const denied = await client.callTool({
      name: 'guild_get_widget_image_url',
      arguments: { guild_id: DENIED },
    });
    expect(denied.isError).toBe(true);
    expect(denied.structuredContent).toMatchObject({
      code: 'GUILD_NOT_ALLOWED',
      guild_id: DENIED,
    });
    expect(get).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });

  it('preflights a channel once, caches it, and never writes to a denied channel', async () => {
    const { client, get, post } = await connect({ ALLOWED_GUILDS: ALLOWED });
    for (const content of ['first', 'second']) {
      const result = await client.callTool({
        name: 'messages_send',
        arguments: { channel_id: ALLOWED_CHANNEL, content },
      });
      expect(result.isError).toBe(false);
    }
    expect(
      get.mock.calls.filter(([route]) => route === `/channels/${ALLOWED_CHANNEL}`),
    ).toHaveLength(1);
    expect(post).toHaveBeenCalledTimes(2);

    const denied = await client.callTool({
      name: 'messages_send',
      arguments: { channel_id: DENIED_CHANNEL, content: 'must not send' },
    });
    expect(denied.structuredContent).toMatchObject({ code: 'GUILD_NOT_ALLOWED' });
    expect(post).toHaveBeenCalledTimes(2);
  });

  it('re-enters the boundary for progressive dispatch and pipeline steps', async () => {
    const progressive = await connect({
      ALLOWED_GUILDS: ALLOWED,
      MCP_TOOL_SURFACE: 'progressive',
    });
    const search = await progressive.client.callTool({
      name: 'mcp_tools_search',
      arguments: { query: 'create global command', limit: 20 },
    });
    const matches = (search.structuredContent as { matches: Array<{ name: string }> }).matches;
    expect(matches.map(({ name }) => name)).not.toContain('commands_create_global');

    const dispatched = await progressive.client.callTool({
      name: 'mcp_tools_read',
      arguments: {
        tool: 'guild_get_widget_image_url',
        args: { guild_id: DENIED },
      },
    });
    expect(dispatched.structuredContent).toMatchObject({ code: 'GUILD_NOT_ALLOWED' });

    const full = await connect({ ALLOWED_GUILDS: ALLOWED });
    const piped = await full.client.callTool({
      name: 'mcp_pipeline',
      arguments: {
        steps: [
          {
            id: 'denied',
            tool: 'guild_get_widget_image_url',
            args: { guild_id: DENIED },
          },
        ],
      },
    });
    expect(piped.structuredContent).toMatchObject({
      aborted: true,
      steps: [
        expect.objectContaining({
          status: 'error',
          error: expect.objectContaining({ code: 'GUILD_NOT_ALLOWED' }),
        }),
      ],
    });
  });

  it('blocks a valid direct interaction call before its token-auth write', async () => {
    const { client, post } = await connect({ ALLOWED_GUILDS: ALLOWED });
    const result = await client.callTool({
      name: 'interactions_create_response',
      arguments: {
        interaction_id: '222233334444555566',
        interaction_token: 'opaque-interaction-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        type: 5,
      },
    });
    expect(result.structuredContent).toMatchObject({ code: 'GUILD_SCOPE_UNRESOLVED' });
    expect(post).not.toHaveBeenCalled();
  });

  it('guards resource subscriptions before adding them to the registry', async () => {
    const { client, subscriptions } = await connect({ ALLOWED_GUILDS: ALLOWED });
    const allowedUri = `discord://guild/${ALLOWED}/info`;
    const deniedUri = `discord://guild/${DENIED}/info`;
    await client.subscribeResource({ uri: allowedUri });
    expect(subscriptions.has(allowedUri)).toBe(true);
    await expect(client.subscribeResource({ uri: deniedUri })).rejects.toThrow(/Guild Restricted/);
    expect(subscriptions.has(deniedUri)).toBe(false);
  });

  it('lists, caches, and invalidates a live guild snapshot through the shared scope policy', async () => {
    const { client, subscriptions, notifyResource, get } = await connect({
      ALLOWED_GUILDS: ALLOWED,
    });
    let version = 1;
    get.mockImplementation(async (route: string) => {
      if (route === `/guilds/${ALLOWED}`) return { id: ALLOWED, name: `Guild ${version}` };
      if (route === `/channels/${ALLOWED_CHANNEL}`) return { guild_id: ALLOWED };
      return {};
    });
    const uri = `discord://guild/${ALLOWED}/info`;
    const listed = await client.listResources();
    expect(listed.resources.map((resource) => resource.uri)).toContain(uri);
    await client.subscribeResource({ uri });
    const first = await client.readResource({ uri });
    expect(JSON.parse(first.contents[0]!.text as string).data.name).toBe('Guild 1');
    version = 2;
    await notifyResource(uri);
    const second = await client.readResource({ uri });
    expect(JSON.parse(second.contents[0]!.text as string).data.name).toBe('Guild 2');
    expect(subscriptions.has(uri)).toBe(true);

    const deniedUri = `discord://guild/${DENIED}/info`;
    await expect(client.readResource({ uri: deniedUri })).rejects.toThrow(/Guild Restricted/);
    expect(get).not.toHaveBeenCalledWith(`/guilds/${DENIED}`);
  });
});
