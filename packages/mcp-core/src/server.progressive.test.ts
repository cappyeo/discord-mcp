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

function successOutputSchema(outputSchema: unknown): Record<string, unknown> {
  const schema = outputSchema as { anyOf?: unknown[] } | undefined;
  const success = schema?.anyOf?.[0];
  if (success === null || typeof success !== 'object' || Array.isArray(success)) {
    throw new Error('Expected a success output-schema arm at anyOf[0].');
  }
  return success as Record<string, unknown>;
}

function sortedKeys(value: unknown): string[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.keys(value).sort();
}

function requiredKeys(value: Record<string, unknown>): string[] {
  const required = value.required;
  return Array.isArray(required)
    ? required.filter((item): item is string => typeof item === 'string').sort()
    : [];
}

describe('progressive tool surface', () => {
  let fullClient: Client;
  let progressiveClient: Client;
  let scopedClient: Client;
  let previewClient: Client;

  beforeAll(async () => {
    [fullClient, progressiveClient, scopedClient, previewClient] = await Promise.all([
      connect(BASE_ENV),
      connect({ ...BASE_ENV, MCP_TOOL_SURFACE: 'progressive' }),
      connect({
        ...BASE_ENV,
        MCP_TOOL_SURFACE: 'progressive',
        MCP_CATEGORIES: 'messages,channels',
      }),
      connect({ ...BASE_ENV, MCP_TOOL_SURFACE: 'progressive', MCP_WRITE_MODE: 'preview' }),
    ]);
  });

  afterAll(async () => {
    await Promise.all([
      fullClient.close(),
      progressiveClient.close(),
      scopedClient.close(),
      previewClient.close(),
    ]);
  });

  it('keeps the full 208-tool surface as the compatibility default', async () => {
    const { tools } = await fullClient.listTools();
    expect(tools).toHaveLength(208);
    expect(tools.map((tool) => tool.name)).not.toContain('mcp_tools_search');
  });

  it('advertises the architecture front door plus discovery dispatchers with at least 90% less catalog JSON', async () => {
    const [{ tools: fullTools }, { tools: progressiveTools }] = await Promise.all([
      fullClient.listTools(),
      progressiveClient.listTools(),
    ]);

    expect(progressiveTools.map((tool) => tool.name)).toEqual([
      'build_discord_server',
      'guild_blueprint_apply',
      'guild_blueprint_evidence',
      'mcp_tools_search',
      'mcp_tools_read',
      'mcp_tools_write',
      'mcp_tools_destructive',
    ]);
    expect(progressiveTools[0]?.description).toContain(
      'Required first step for Discord server architecture',
    );
    expect(progressiveTools[0]?.description).toContain('Do not ask which kind of server');
    expect(progressiveTools[0]?.description).toContain('exactly once');
    expect(progressiveTools[0]?.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
    });
    expect(progressiveTools[0]?.inputSchema).toMatchObject({
      required: ['request'],
      properties: { request: expect.any(Object) },
    });
    expect(progressiveTools[0]?.outputSchema).toMatchObject({
      type: 'object',
      anyOf: expect.any(Array),
    });
    for (const toolName of ['guild_blueprint_apply', 'guild_blueprint_evidence']) {
      const tool = progressiveTools.find((candidate) => candidate.name === toolName);
      expect(tool?.inputSchema).toMatchObject({ type: 'object' });
      expect(tool?.outputSchema).toMatchObject({ type: 'object', anyOf: expect.any(Array) });
    }
    expect(
      progressiveTools.find((tool) => tool.name === 'guild_blueprint_apply')?.annotations,
    ).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(
      progressiveTools.find((tool) => tool.name === 'guild_blueprint_evidence')?.annotations,
    ).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(
      progressiveTools.find((tool) => tool.name === 'mcp_tools_read')?.annotations,
    ).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(
      progressiveTools.find((tool) => tool.name === 'mcp_tools_write')?.annotations,
    ).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(
      progressiveTools.find((tool) => tool.name === 'mcp_tools_destructive')?.annotations,
    ).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(
      progressiveTools.find((tool) => tool.name === 'mcp_tools_search')?.description,
    ).toContain('means a Discord guild');
    expect(
      progressiveTools.find((tool) => tool.name === 'mcp_tools_search')?.description,
    ).toContain('unless the user explicitly says otherwise');
    const progressiveBytes = Buffer.byteLength(JSON.stringify(progressiveTools));
    expect(progressiveBytes).toBeLessThan(16_000);
    expect(Buffer.byteLength(JSON.stringify(progressiveTools))).toBeLessThan(
      Buffer.byteLength(JSON.stringify(fullTools)) * 0.1,
    );
    expect(progressiveClient.getInstructions()).toContain('Progressive tool surface');
    expect(progressiveClient.getInstructions()).toContain('means a Discord guild');
    expect(progressiveClient.getInstructions()).toContain(
      'directly advertised build_discord_server first',
    );
    expect(progressiveClient.getInstructions()).toContain('do not repeat identical calls');
  });

  it('keeps compact architecture output schemas aligned with canonical full contracts', async () => {
    const [{ tools: fullTools }, { tools: progressiveTools }] = await Promise.all([
      fullClient.listTools(),
      progressiveClient.listTools(),
    ]);
    const mappings = [
      ['build_discord_server', 'guild_blueprint_plan'],
      ['guild_blueprint_apply', 'guild_blueprint_apply'],
      ['guild_blueprint_evidence', 'guild_blueprint_evidence'],
    ] as const;

    for (const [progressiveName, canonicalName] of mappings) {
      const compact = progressiveTools.find((tool) => tool.name === progressiveName);
      const canonical = fullTools.find((tool) => tool.name === canonicalName);
      expect(compact?.outputSchema).toBeDefined();
      expect(canonical?.outputSchema).toBeDefined();

      const compactSuccess = successOutputSchema(compact?.outputSchema);
      const canonicalSuccess = successOutputSchema(canonical?.outputSchema);
      expect(sortedKeys(compactSuccess.properties)).toEqual(
        sortedKeys(canonicalSuccess.properties),
      );
      expect(requiredKeys(compactSuccess)).toEqual(requiredKeys(canonicalSuccess));

      const compactStatus = (compactSuccess.properties as Record<string, unknown>).status as {
        enum?: unknown;
      };
      const canonicalStatus = (canonicalSuccess.properties as Record<string, unknown>).status as {
        enum?: unknown;
      };
      expect(compactStatus?.enum).toEqual(canonicalStatus?.enum);
    }
  });

  it('keeps the direct architecture front door inside category authorization', async () => {
    const { tools } = await scopedClient.listTools();
    expect(tools.map((tool) => tool.name)).not.toContain('build_discord_server');
    expect(tools.map((tool) => tool.name)).not.toContain('guild_blueprint_apply');
    expect(tools.map((tool) => tool.name)).not.toContain('guild_blueprint_evidence');
    expect(scopedClient.getInstructions()).toContain(
      'Architecture tools are unavailable under the active MCP_CATEGORIES policy',
    );
    const directCall = await scopedClient.callTool({
      name: 'build_discord_server',
      arguments: { request: 'Build a professional gaming Discord server' },
    });
    expect(directCall.isError).toBe(true);
    expect(directCall.structuredContent).toMatchObject({ code: 'SCOPE_REJECTED' });
  });

  it('sends the direct architecture front door through normal validation middleware', async () => {
    const result = await progressiveClient.callTool({
      name: 'build_discord_server',
      arguments: {},
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('returns a direct contract for a single match and exact authorized schemas on demand', async () => {
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
      arguments: { query: 'send a message', limit: 1 },
    });
    expect(result.isError).toBe(false);
    const matches = (result.structuredContent as { matches: Array<Record<string, unknown>> })
      .matches;
    expect(matches[0]?.name).toBe('messages_send');
    const send = matches.find((match) => match.name === 'messages_send');
    expect(send).toMatchObject({
      category: 'messages',
      dispatcher: 'mcp_tools_write',
      summary: expect.any(String),
      inputSchema: expect.objectContaining({
        properties: expect.objectContaining({
          channel_id: expect.any(Object),
          content: expect.any(Object),
        }),
      }),
      annotations: expect.objectContaining({ openWorldHint: true }),
    });

    const exact = await progressiveClient.callTool({
      name: 'mcp_tools_search',
      arguments: { query: 'messages_send' },
    });
    expect(exact.isError).toBe(false);
    const exactMatches = (exact.structuredContent as { matches: Array<Record<string, unknown>> })
      .matches;
    expect(exact.structuredContent).toMatchObject({ total_matches: 1 });
    expect(exactMatches).toHaveLength(1);
    const exactSend = exactMatches.find((match) => match.name === 'messages_send');
    expect(exactSend).toMatchObject({
      inputSchema: expect.objectContaining({
        properties: expect.objectContaining({
          channel_id: expect.any(Object),
          content: expect.any(Object),
        }),
      }),
      annotations: expect.objectContaining({ openWorldHint: true }),
    });

    const permission = await progressiveClient.callTool({
      name: 'mcp_tools_search',
      arguments: { query: 'permissions_explain' },
    });
    expect(permission.isError).toBe(false);
    expect(permission.structuredContent).toMatchObject({
      total_matches: 1,
      matches: [
        expect.objectContaining({
          name: 'permissions_explain',
          category: 'permissions',
          dispatcher: 'mcp_tools_read',
        }),
      ],
    });

    const channelAudit = await progressiveClient.callTool({
      name: 'mcp_tools_search',
      arguments: { query: 'permissions_audit_channel' },
    });
    expect(channelAudit.isError).toBe(false);
    expect(channelAudit.structuredContent).toMatchObject({
      total_matches: 1,
      matches: [
        expect.objectContaining({
          name: 'permissions_audit_channel',
          category: 'permissions',
          dispatcher: 'mcp_tools_read',
        }),
      ],
    });
  });

  it('routes natural server-architecture requests to the high-level blueprint planner', async () => {
    for (const query of [
      'build a professional gaming Discord server with preview, safe resume, and evidence',
      'create a gaming community with LFG, voice rooms, events, onboarding, and moderation',
      'create a gaming server',
      'make a gaming server',
      'dựng cho tôi server gaming',
      'dựng cho tôi một server gaming chuyên nghiệp, an toàn, có preview, tiếp tục khi gián đoạn và bằng chứng hoàn tất',
      'tạo một server gaming',
      'tạo cho tôi một server gaming',
    ]) {
      const result = await progressiveClient.callTool({
        name: 'mcp_tools_search',
        arguments: { query, limit: 1 },
      });

      expect(result.isError).toBe(false);
      expect(result.structuredContent).toMatchObject({
        matches: [
          expect.objectContaining({
            name: 'guild_blueprint_plan',
            category: 'guild',
            dispatcher: 'mcp_tools_read',
            inputSchema: expect.objectContaining({
              required: ['request'],
              properties: expect.objectContaining({
                request: expect.any(Object),
                guild_id: expect.any(Object),
                expected_bot_id: expect.any(Object),
              }),
            }),
          }),
        ],
      });
    }
  });

  it('keeps resource-level requests inside an existing server on their narrow tool', async () => {
    for (const { query, toolName } of [
      { query: 'create a scheduled event in my server', toolName: 'events_create' },
      { query: 'create gaming events in my Discord server', toolName: 'events_create' },
      { query: 'make a gaming event in my server', toolName: 'events_create' },
      { query: 'set up a gaming event inside our community', toolName: 'events_create' },
      { query: 'dựng một event trong server', toolName: 'events_create' },
      { query: 'tạo một sự kiện trong server', toolName: 'events_create' },
      { query: 'thêm một kênh trong server', toolName: 'channels_create_guild_channel' },
    ]) {
      const result = await progressiveClient.callTool({
        name: 'mcp_tools_search',
        arguments: { query, limit: 1 },
      });

      expect(result.isError).toBe(false);
      expect(result.structuredContent).toMatchObject({
        matches: [
          expect.objectContaining({
            name: toolName,
            dispatcher: 'mcp_tools_write',
          }),
        ],
      });
    }
  });

  it('cuts category browse by 80% and the selected-tool discovery journey by 50%', async () => {
    const [compact, full, exact] = await Promise.all([
      progressiveClient.callTool({
        name: 'mcp_tools_search',
        arguments: { category: 'channels', limit: 8 },
      }),
      progressiveClient.callTool({
        name: 'mcp_tools_search',
        arguments: { category: 'channels', limit: 8, detail: 'full' },
      }),
      progressiveClient.callTool({
        name: 'mcp_tools_search',
        arguments: { query: 'channels_get' },
      }),
    ]);

    expect(compact.isError).toBe(false);
    expect(full.isError).toBe(false);
    expect(exact.isError).toBe(false);
    expect(compact.structuredContent).toMatchObject({ detail: 'compact' });
    expect(full.structuredContent).toMatchObject({ detail: 'full' });
    const compactBytes = Buffer.byteLength(JSON.stringify(compact.structuredContent));
    const fullBytes = Buffer.byteLength(JSON.stringify(full.structuredContent));
    expect(compactBytes).toBeLessThan(fullBytes * 0.2);
    const exactBytes = Buffer.byteLength(JSON.stringify(exact.structuredContent));
    expect(compactBytes).toBeLessThan(3_000);
    expect(exactBytes).toBeLessThan(2_400);
    expect(compactBytes + exactBytes).toBeLessThan(5_000);
    expect(compactBytes + exactBytes).toBeLessThan(fullBytes * 0.5);
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

  it('discovers templates_recommend for a gaming server and reads it through mcp_tools_read', async () => {
    const search = await progressiveClient.callTool({
      name: 'mcp_tools_search',
      arguments: { query: 'gaming server', limit: 20 },
    });
    expect(search.isError).toBe(false);
    expect(search.structuredContent).toMatchObject({
      matches: expect.arrayContaining([
        expect.objectContaining({
          name: 'templates_recommend',
          category: 'templates',
          dispatcher: 'mcp_tools_read',
        }),
      ]),
      categories: expect.arrayContaining([{ name: 'templates', tool_count: 9 }]),
    });

    const read = await progressiveClient.callTool({
      name: 'mcp_tools_read',
      arguments: { tool: 'templates_recommend', args: {} },
    });
    expect(read.isError).toBe(true);
    expect(read.structuredContent).toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('discovers the target-bound guild blueprint planner through mcp_tools_read', async () => {
    const search = await progressiveClient.callTool({
      name: 'mcp_tools_search',
      arguments: { query: 'build a professional gaming guild with a safe preview', limit: 20 },
    });
    expect(search.isError).toBe(false);
    expect(search.structuredContent).toMatchObject({
      matches: expect.arrayContaining([
        expect.objectContaining({
          name: 'guild_blueprint_plan',
          category: 'guild',
          dispatcher: 'mcp_tools_read',
        }),
      ]),
      categories: expect.arrayContaining([{ name: 'guild', tool_count: 20 }]),
    });

    const read = await progressiveClient.callTool({
      name: 'mcp_tools_read',
      arguments: { tool: 'guild_blueprint_plan', args: {} },
    });
    expect(read.isError).toBe(true);
    expect(read.structuredContent).toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('discovers restart-safe Activity Evidence verification through mcp_tools_read', async () => {
    const search = await progressiveClient.callTool({
      name: 'mcp_tools_search',
      arguments: { query: 'verify blueprint Activity Evidence after restart', limit: 20 },
    });
    expect(search.isError).toBe(false);
    expect(search.structuredContent).toMatchObject({
      matches: expect.arrayContaining([
        expect.objectContaining({
          name: 'guild_blueprint_evidence',
          category: 'guild',
          dispatcher: 'mcp_tools_read',
        }),
      ]),
      categories: expect.arrayContaining([{ name: 'guild', tool_count: 20 }]),
    });

    const read = await progressiveClient.callTool({
      name: 'mcp_tools_read',
      arguments: { tool: 'guild_blueprint_evidence', args: {} },
    });
    expect(read.isError).toBe(true);
    expect(read.structuredContent).toMatchObject({ code: 'VALIDATION_FAILED' });
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

  it('applies all-write preview after progressive write dispatch', async () => {
    const result = await previewClient.callTool({
      name: 'mcp_tools_write',
      arguments: {
        tool: 'messages_send',
        args: { channel_id: '112233445566778899', content: 'preview only' },
      },
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      code: 'WRITE_PREVIEW',
      tool: 'messages_send',
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
