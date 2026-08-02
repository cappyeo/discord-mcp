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
  const client = new Client({ name: 'progressive-test', version: '0.0.0' }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

describe('progressive tool surface', () => {
  let fullClient: Client;
  let progressiveClient: Client;
  let scopedClient: Client;

  beforeAll(async () => {
    [fullClient, progressiveClient, scopedClient] = await Promise.all([
      connect(BASE_ENV),
      connect({ ...BASE_ENV, MCP_TOOL_SURFACE: 'progressive' }),
      connect({
        ...BASE_ENV,
        MCP_TOOL_SURFACE: 'progressive',
        MCP_CATEGORIES: 'messages,channels',
      }),
    ]);
  });

  afterAll(async () => {
    await Promise.all([fullClient.close(), progressiveClient.close(), scopedClient.close()]);
  });

  it('keeps the full 192-tool surface as the compatibility default', async () => {
    const { tools } = await fullClient.listTools();
    expect(tools).toHaveLength(192);
    expect(tools.map((tool) => tool.name)).not.toContain('mcp_tools_search');
  });

  it('advertises only search and risk-specific dispatchers with at least 90% less catalog JSON', async () => {
    const [{ tools: fullTools }, { tools: progressiveTools }] = await Promise.all([
      fullClient.listTools(),
      progressiveClient.listTools(),
    ]);

    expect(progressiveTools.map((tool) => tool.name)).toEqual([
      'mcp_tools_search',
      'mcp_tools_read',
      'mcp_tools_write',
      'mcp_tools_destructive',
    ]);
    expect(
      progressiveTools.find((tool) => tool.name === 'mcp_tools_read')?.annotations,
    ).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(
      progressiveTools.find((tool) => tool.name === 'mcp_tools_write')?.annotations,
    ).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(
      progressiveTools.find((tool) => tool.name === 'mcp_tools_destructive')?.annotations,
    ).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(Buffer.byteLength(JSON.stringify(progressiveTools))).toBeLessThan(
      Buffer.byteLength(JSON.stringify(fullTools)) * 0.1,
    );
    expect(progressiveClient.getInstructions()).toContain('Progressive tool surface');
  });

  it('discovers exact authorized schemas on demand', async () => {
    const categories = await progressiveClient.callTool({
      name: 'mcp_tools_search',
      arguments: {},
    });
    expect(categories.isError).toBe(false);
    expect(categories.structuredContent).toMatchObject({
      matches: [],
      categories: expect.arrayContaining([
        expect.objectContaining({ name: 'messages', tool_count: expect.any(Number) }),
      ]),
    });

    const result = await progressiveClient.callTool({
      name: 'mcp_tools_search',
      arguments: { query: 'send a message', limit: 5 },
    });
    expect(result.isError).toBe(false);
    const matches = (result.structuredContent as { matches: Array<Record<string, unknown>> })
      .matches;
    expect(matches[0]?.name).toBe('messages_send');
    const send = matches.find((match) => match.name === 'messages_send');
    expect(send).toMatchObject({
      category: 'messages',
      dispatcher: 'mcp_tools_write',
      inputSchema: expect.objectContaining({
        properties: expect.objectContaining({
          channel_id: expect.any(Object),
          content: expect.any(Object),
        }),
      }),
      annotations: expect.objectContaining({ openWorldHint: true }),
    });
  });

  it('invokes a hidden discovered tool through the risk-matched dispatcher', async () => {
    const { tools } = await progressiveClient.listTools();
    expect(tools.map((tool) => tool.name)).not.toContain('components_v2_build_container');

    const result = await progressiveClient.callTool({
      name: 'mcp_tools_read',
      arguments: {
        tool: 'components_v2_build_container',
        args: { components: [{ type: 10, content: 'hello' }] },
      },
    });
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toMatchObject({
      component: expect.objectContaining({ type: 17 }),
    });
  });

  it('never exposes or dispatches beyond MCP_CATEGORIES', async () => {
    const search = await scopedClient.callTool({
      name: 'mcp_tools_search',
      arguments: { query: 'ban a member', limit: 20 },
    });
    const names = (search.structuredContent as { matches: Array<{ name: string }> }).matches.map(
      (match) => match.name,
    );
    expect(names).not.toContain('members_ban');

    const call = await scopedClient.callTool({
      name: 'mcp_tools_destructive',
      arguments: {
        tool: 'members_ban',
        args: { guild_id: '111122223333444455', user_id: '999000999000999000' },
      },
    });
    expect(call.isError).toBe(true);
    expect(call.structuredContent).toMatchObject({
      code: 'TOOL_NOT_AVAILABLE',
    });

    const direct = await scopedClient.callTool({
      name: 'members_ban',
      arguments: { guild_id: '111122223333444455', user_id: '999000999000999000' },
    });
    expect(direct.structuredContent).toMatchObject({ code: 'SCOPE_REJECTED' });
  });

  it('rejects a tool sent through the wrong risk dispatcher', async () => {
    const result = await progressiveClient.callTool({
      name: 'mcp_tools_read',
      arguments: {
        tool: 'messages_send',
        args: { channel_id: '112233445566778899', content: 'not sent' },
      },
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      code: 'DISPATCH_MODE_MISMATCH',
      recovery_hint: expect.stringContaining('mcp_tools_write'),
    });
  });

  it('preserves destructive confirmation and dry-run gates after dispatch', async () => {
    const result = await progressiveClient.callTool({
      name: 'mcp_tools_destructive',
      arguments: {
        tool: 'messages_delete',
        args: { channel_id: '111122223333444455', message_id: '999000999000999000' },
      },
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      code: 'DRY_RUN_PREVIEW',
      tool: 'messages_delete',
    });
  });

  it('returns a structured validation error for malformed search input', async () => {
    const result = await progressiveClient.callTool({
      name: 'mcp_tools_search',
      arguments: { limit: 100 },
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      code: 'VALIDATION_FAILED',
      retriable: false,
      category: 'client',
    });
  });
});
