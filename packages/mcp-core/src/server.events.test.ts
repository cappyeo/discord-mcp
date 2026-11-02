import { REST } from '@discordjs/rest';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { loadConfig } from './config.js';
import { eventDefinition } from './events/contract.js';
import { createLogger } from './logger.js';
import { buildServer } from './server.js';

it.each([
  'allow',
  'preview',
] as const)('keeps event replies inside guild and write policy with mode=%s', async (writeMode) => {
  const guild = '111122223333444481';
  const bot = '111122223333444482';
  const call = vi.fn(async (method: string, _params: unknown) =>
    method === 'message/scope'
      ? { guild_id: guild, bot_id: bot }
      : { status: 'sent', message_id: '111122223333444485' },
  );
  const config = loadConfig({
    DISCORD_TOKEN: 'x'.repeat(60),
    LOG_LEVEL: 'fatal',
    MCP_AUDIT_SINK: 'none',
    MCP_TOOL_SURFACE: 'progressive',
    ALLOWED_GUILDS: guild,
    DISCORD_EXPECTED_BOT_ID: bot,
    MCP_ACCESS_MODE: 'enforce',
    MCP_WRITE_MODE: writeMode,
  });
  const rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake');
  vi.spyOn(rest, 'get').mockResolvedValue({ id: bot, bot: true });
  const built = await buildServer({
    rest,
    logger: createLogger(config),
    config,
    eventBridge: { call },
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'events-policy', version: '1' });
  await Promise.all([built.server.connect(b), client.connect(a)]);
  try {
    const result = await client.callTool({
      name: 'mcp_tools_write',
      arguments: {
        tool: 'events_message_reply',
        args: { event_id: 'discord_mention_111122223333444483', content: 'Hello' },
      },
    });
    if (writeMode === 'allow') {
      expect(result).toMatchObject({ structuredContent: { status: 'sent' } });
      expect(call).toHaveBeenCalledWith('message/scope', {
        event_id: 'discord_mention_111122223333444483',
      });
    }
    expect(call.mock.calls.filter(([method]) => method === 'message/reply')).toHaveLength(
      writeMode === 'allow' ? 1 : 0,
    );
  } finally {
    await client.close();
  }
});

it('advertises Events and preserves progressive tools across concurrent MCP sessions', async () => {
  const call = vi.fn(async (method: string, _params: unknown) =>
    method === 'events/list'
      ? { events: [eventDefinition('111122223333444481')] }
      : { status: 'sent', message_id: '111122223333444485' },
  );
  const config = loadConfig({
    DISCORD_TOKEN: 'Bot fake.test.token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    LOG_LEVEL: 'fatal',
    MCP_TOOL_SURFACE: 'progressive',
  });
  const clients: Client[] = [];
  try {
    for (let i = 0; i < 3; i++) {
      const build = await buildServer({
        rest: new REST({ version: '10', makeRequest: fetch }).setToken('fake'),
        logger: createLogger(config),
        config,
        eventBridge: { call },
      });
      const [a, b] = InMemoryTransport.createLinkedPair();
      const client = new Client(
        { name: 'events-probe', version: '1' },
        { versionNegotiation: { mode: 'auto' } },
      );
      clients.push(client);
      await Promise.all([build.server.connect(b), client.connect(a)]);
      expect(build.server.getCapabilities()).toMatchObject({ events: {}, tools: {} });
      expect((await client.listTools()).tools).toHaveLength(7);
      const result = await client.request(
        { method: 'events/list', params: {} },
        z.object({ events: z.array(z.unknown()) }),
      );
      expect(result.events).toHaveLength(1);
      const search = await client.callTool({
        name: 'mcp_tools_search',
        arguments: { query: 'events_dm_reply' },
      });
      expect(search.structuredContent).toMatchObject({
        matches: [{ name: 'events_dm_reply', dispatcher: 'mcp_tools_write' }],
      });
      const guildSearch = await client.callTool({
        name: 'mcp_tools_search',
        arguments: { query: 'events_message_reply' },
      });
      for (const tool of ['events_dm_context', 'events_message_context']) {
        expect(
          await client.callTool({
            name: 'mcp_tools_read',
            arguments: { tool, args: { event_id: 'accepted-event', limit: 20 } },
          }),
        ).toMatchObject({ structuredContent: { status: 'sent' } });
        expect(
          await client.callTool({
            name: 'mcp_tools_read',
            arguments: {
              tool,
              args: { event_id: 'accepted-event', channel_id: 'arbitrary-channel' },
            },
          }),
        ).toMatchObject({ structuredContent: { status: 'sent' } });
        expect(call).toHaveBeenLastCalledWith(
          tool === 'events_dm_context' ? 'dm/context' : 'message/context',
          { event_id: 'accepted-event', limit: 20 },
        );
        expect(
          await client.callTool({
            name: 'mcp_tools_read',
            arguments: { tool, args: { event_id: 'accepted-event', limit: 31 } },
          }),
        ).toMatchObject({ isError: true });
      }
      expect(guildSearch.structuredContent).toMatchObject({
        matches: [{ name: 'events_message_reply', dispatcher: 'mcp_tools_write' }],
      });
      expect(
        await client.callTool({
          name: 'mcp_tools_write',
          arguments: {
            tool: 'events_message_reply',
            args: { event_id: 'discord_mention_111122223333444484', content: 'Public reply' },
          },
        }),
      ).toMatchObject({ structuredContent: { status: 'sent' } });
      expect(
        await client.callTool({
          name: 'mcp_tools_read',
          arguments: { tool: 'events_dm_reply', args: { event_id: 'x', content: 'x' } },
        }),
      ).toMatchObject({ isError: true });
      expect(
        await client.callTool({
          name: 'mcp_tools_write',
          arguments: {
            tool: 'events_dm_reply',
            args: { event_id: 'discord_dm_111122223333444484', content: 'Hi' },
          },
        }),
      ).toMatchObject({ structuredContent: { status: 'sent' } });
    }
    expect(call.mock.calls.filter((c) => c[0] === 'dm/context')).toHaveLength(6);
    expect(call.mock.calls.filter((c) => c[0] === 'message/context')).toHaveLength(6);
    expect(call.mock.calls.filter((c) => c[0] === 'dm/reply')).toHaveLength(3);
    expect(call.mock.calls.filter((c) => c[0] === 'message/reply')).toHaveLength(3);
  } finally {
    await Promise.all(clients.map((c) => c.close()));
  }
});
