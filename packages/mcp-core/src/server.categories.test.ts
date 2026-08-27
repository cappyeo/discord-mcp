/**
 * `MCP_CATEGORIES` - the least-privilege deployment control.
 *
 * It was advertised in two published doc pages and in an error recovery hint,
 * but the `category_enabled` precondition that implemented it was referenced
 * by zero of the 208 tools, so the variable restricted nothing: an operator
 * who set `MCP_CATEGORIES=messages` still shipped a server that could ban
 * members and delete channels.
 *
 * Both layers are asserted here. Hiding a tool from `tools/list` is not a
 * control - a client can call an unlisted tool by name - and gating without
 * hiding fills the agent's context with tools that only ever fail.
 */
import { REST } from '@discordjs/rest';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { buildServer } from './server.js';

const BASE_ENV = {
  DISCORD_TOKEN: 'Bot fake.test.token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  LOG_LEVEL: 'fatal',
} as NodeJS.ProcessEnv;

async function connect(env: NodeJS.ProcessEnv): Promise<Client> {
  const config = loadConfig(env);
  const logger = createLogger(config);
  const rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token');
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const { server } = await buildServer({ rest, logger, config });
  const client = new Client({ name: 'categories-test', version: '0.0.0' }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

describe('MCP_CATEGORIES allowlist', () => {
  let client: Client;

  beforeAll(async () => {
    client = await connect({ ...BASE_ENV, MCP_CATEGORIES: 'messages,channels' });
  });

  afterAll(async () => {
    await client.close();
  });

  it('lists only the allowed categories (plus meta)', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain('messages_send');
    expect(names).toContain('channels_get');
    expect(names).not.toContain('members_ban');
    expect(names).not.toContain('roles_create');
    expect(names).not.toContain('inspiration_emoji_gg_search');
    // meta stays reachable so introspection does not vanish on a scoped deploy.
    expect(names).toContain('mcp_pipeline');
    expect(tools.length).toBeLessThan(208);
  });

  it('rejects a disallowed tool called by name, not just hidden from the list', async () => {
    const r = await client.callTool({
      name: 'members_ban',
      arguments: { guild_id: '111122223333444455', user_id: '999000999000999000' },
    });
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toMatchObject({ code: 'SCOPE_REJECTED' });
  });

  it('still allows a tool in an granted category', async () => {
    const r = await client.callTool({
      name: 'messages_send',
      arguments: { channel_id: '112233445566778899', content: 'hi' },
    });
    expect(r.isError).toBe(false);
  });

  it('points the recovery hint at the real variable name', async () => {
    const r = await client.callTool({
      name: 'members_ban',
      arguments: { guild_id: '111122223333444455', user_id: '999000999000999000' },
    });
    const text = (r.content as Array<{ text: string }>)[0]?.text ?? '';
    expect(text).toContain('MCP_CATEGORIES');
    expect(text).not.toContain('MCP_SCOPES');
  });
});

describe('MCP_CATEGORIES validation and defaults', () => {
  it('allows everything when unset', async () => {
    const client = await connect(BASE_ENV);
    const { tools } = await client.listTools();
    expect(tools.length).toBe(208);
    await client.close();
  });

  it('allows everything when blank', async () => {
    const client = await connect({ ...BASE_ENV, MCP_CATEGORIES: '   ' });
    const { tools } = await client.listTools();
    expect(tools.length).toBe(208);
    await client.close();
  });

  it('fails fast on an unknown category rather than silently disabling it', async () => {
    // The failure mode this prevents: `MCP_CATEGORIES=messsages` (typo) boots
    // a server where messages tools are all rejected and nothing says why.
    const config = loadConfig({ ...BASE_ENV, MCP_CATEGORIES: 'messsages' });
    const logger = createLogger(config);
    const rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token');
    await expect(buildServer({ rest, logger, config })).rejects.toThrow(/messsages/);
  });

  it('tolerates whitespace and empty entries in the list', async () => {
    const client = await connect({ ...BASE_ENV, MCP_CATEGORIES: ' messages , , channels ' });
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain('messages_send');
    expect(tools.map((t) => t.name)).not.toContain('members_ban');
    await client.close();
  });

  it('allows the permissions category independently', async () => {
    const client = await connect({ ...BASE_ENV, MCP_CATEGORIES: 'permissions' });
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).toContain('permissions_audit_channel');
    expect(names).toContain('permissions_explain');
    expect(names).not.toContain('roles_create');
    await client.close();
  });

  it('exposes bot-scoped application emoji writes when the bot identity is locked', async () => {
    const client = await connect({
      ...BASE_ENV,
      ALLOWED_GUILDS: '111122223333444455',
      // This is the deterministic bot ID returned by server-mocks for
      // /users/@me (snowflake('bot_self')).
      DISCORD_EXPECTED_BOT_ID: '100002088458902020',
    });
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).toContain('app_emojis_create');
    expect(names).toContain('app_emojis_modify');
    expect(names).toContain('app_emojis_delete');
    await client.close();
  });

  it('rejects an application emoji write aimed at another application', async () => {
    const client = await connect({
      ...BASE_ENV,
      ALLOWED_GUILDS: '111122223333444455',
      DISCORD_EXPECTED_BOT_ID: '100002088458902020',
    });
    const result = await client.callTool({
      name: 'app_emojis_create',
      arguments: {
        application_id: '999000999000999000',
        name: 'spark',
        image: 'data:image/png;base64,dGlueQ==',
      },
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ code: 'BOT_SCOPE_UNRESOLVED' });
    await client.close();
  });
});
