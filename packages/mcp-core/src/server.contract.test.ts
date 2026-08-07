import { REST } from '@discordjs/rest';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import packageJson from '../package.json' with { type: 'json' };
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { buildServer } from './server.js';

describe('MCP protocol contract', () => {
  const fakeEnv = {
    DISCORD_TOKEN: 'Bot fake.test.token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    LOG_LEVEL: 'fatal',
  } as NodeJS.ProcessEnv;
  const config = loadConfig(fakeEnv);
  const logger = createLogger(config);

  let client: Client;
  let subscriptions: Awaited<ReturnType<typeof buildServer>>['subscriptions'];

  beforeAll(async () => {
    // Construct REST inside beforeAll so the `fetch` reference is captured AFTER msw has
    // patched globalThis.fetch in the setupFiles beforeAll hook.
    const rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token');
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const built = await buildServer({ rest, logger, config });
    const { server } = built;
    subscriptions = built.subscriptions;
    client = new Client({ name: 'contract-test', version: '0.0.0' }, { capabilities: {} });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  afterAll(async () => {
    await client.close();
  });

  it('listTools returns at least 1 tool with valid JSON Schema', async () => {
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThanOrEqual(1);
    for (const t of tools) {
      expect(t.name).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(t.description).toBeTypeOf('string');
      expect(t.inputSchema).toMatchObject({ type: 'object' });
    }
  });

  it('messages_send is registered', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain('messages_send');
  });

  it('advertises defaulted input fields as optional', async () => {
    const { tools } = await client.listTools();
    const read = tools.find((tool) => tool.name === 'messages_read');
    const event = tools.find((tool) => tool.name === 'events_create');
    expect(read?.inputSchema.properties).toHaveProperty('limit');
    expect((read?.inputSchema.required as string[]) ?? []).not.toContain('limit');
    expect(event?.inputSchema.properties).toHaveProperty('privacy_level');
    expect((event?.inputSchema.required as string[]) ?? []).not.toContain('privacy_level');
  });

  it('callTool with invalid args returns isError=true (not throws)', async () => {
    const r = await client.callTool({ name: 'messages_send', arguments: {} });
    expect(r.isError).toBe(true);
    const text = (r.content as Array<{ type: string; text: string }>)[0];
    expect(text.type).toBe('text');
    expect(text.text).toMatch(/input error/i);
  });

  it('callTool with valid args returns dualResult shape', async () => {
    const r = await client.callTool({
      name: 'messages_send',
      arguments: { channel_id: '112233445566778899', content: 'hi' },
    });
    expect(r.isError).toBe(false);
    expect(r.structuredContent).toMatchObject({
      message_id: '999000999000999000',
      jump_url: expect.stringContaining('discord.com/channels/'),
    });
  });

  it('callTool with malformed channel_id returns DISCORD-formatted ValidationError', async () => {
    const r = await client.callTool({
      name: 'messages_send',
      arguments: { channel_id: 'not-a-snowflake', content: 'hi' },
    });
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toMatchObject({
      code: 'VALIDATION_FAILED',
      retriable: false,
      category: 'client',
    });
    const text = (r.content as Array<{ text: string }>)[0]!.text;
    expect(text).toMatch(/Input Error/);
    expect(text).toMatch(/channel_id/);
  });

  it('lists 201 tools after auto-discovery', async () => {
    const { tools } = await client.listTools();
    expect(tools.length).toBe(201);
    const names = new Set(tools.map((t) => t.name));
    for (const expected of [
      'messages_send',
      'messages_read',
      'messages_edit',
      'messages_delete',
      'channels_list',
      'channels_get',
      'members_get',
      'members_search',
      'inspiration_emoji_gg_search',
      'templates_get',
      'templates_inspect',
      'templates_diff',
      'roles_list',
      'guild_get',
      'audit_log_get',
      'webhooks_list_channel',
      'events_list',
      'commands_list_guild',
      'users_get_current',
      'components_v2_build_container',
      'components_v2_build_section',
      'components_v2_build_media_gallery',
      'components_v2_validate',
      'components_v2_preview',
      'components_v2_send',
      'components_v2_edit',
      'components_v2_send_from_template',
      'mcp_pipeline',
      'intelligence_summarize_channel',
      'intelligence_classify_messages',
      'intelligence_draft_response',
      'intelligence_moderate_content',
      'intelligence_extract_entities',
    ]) {
      expect(names.has(expected)).toBe(true);
    }
  });

  it('intelligence_summarize_channel returns fallback when client lacks sampling', async () => {
    const r = await client.callTool({
      name: 'intelligence_summarize_channel',
      arguments: { channel_id: '112233445566778899', limit: 10, style: 'bullet' },
    });
    expect(r.isError).toBe(false);
    expect(r.structuredContent).toMatchObject({
      _meta: expect.objectContaining({ fallback: 'host_llm_should_process' }),
    });
  });

  it('mcp_pipeline executes a 2-step pipeline end-to-end', async () => {
    const r = await client.callTool({
      name: 'mcp_pipeline',
      arguments: {
        steps: [
          { id: 'step1', tool: 'channels_list', args: { guild_id: '999000999000999000' } },
          {
            id: 'step2',
            tool: 'messages_send',
            args: { channel_id: '{{step1.channels[0].id}}', content: 'pipeline ran' },
          },
        ],
      },
    });
    expect(r.isError).toBe(false);
    expect(r.structuredContent).toMatchObject({
      aborted: false,
      steps: expect.arrayContaining([
        expect.objectContaining({ id: 'step1', status: 'success' }),
        expect.objectContaining({ id: 'step2', status: 'success' }),
      ]),
    });
  });

  it('mcp_pipeline rejects nested pipeline calls', async () => {
    const r = await client.callTool({
      name: 'mcp_pipeline',
      arguments: { steps: [{ id: 'inner', tool: 'mcp_pipeline', args: { steps: [] } }] },
    });
    expect(r.isError).toBe(false);
    expect(r.structuredContent).toMatchObject({
      aborted: true,
      steps: expect.arrayContaining([
        expect.objectContaining({
          status: 'error',
          error: expect.objectContaining({ code: 'PIPELINE_RECURSION' }),
        }),
      ]),
    });
  });

  it('messages_delete returns DRY_RUN_PREVIEW without __confirm', async () => {
    const r = await client.callTool({
      name: 'messages_delete',
      arguments: { channel_id: '111122223333444455', message_id: '999000999000999000' },
    });
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toMatchObject({ code: 'DRY_RUN_PREVIEW', tool: 'messages_delete' });
  });

  it('reports the real package version in the initialize handshake', () => {
    // Was hardcoded '0.0.0'. Clients use this for compatibility gating and
    // bug reports, so a stale value silently misroutes both.
    expect(client.getServerVersion()).toMatchObject({
      name: 'discord-mcp',
      version: packageJson.version,
    });
  });

  it('sends instructions that describe the actual tool surface', () => {
    // Was 'v0/Plan-1 - only messages_send available', injected into the
    // agent's system context on a 201-tool server - actively steering the
    // model away from 198 of them.
    const instructions = client.getInstructions() ?? '';
    expect(instructions).not.toContain('only messages_send');
    expect(instructions).not.toContain('Plan-1');
    expect(instructions).toContain('201 tools');
    expect(instructions).toContain('__confirm');
    expect(instructions).toContain('untrusted');
  });

  it('advertises __confirm in the JSON Schema of confirm-gated tools only', async () => {
    const { tools } = await client.listTools();
    const gated = tools.find((t) => t.name === 'messages_delete');
    expect(gated?.inputSchema.properties).toHaveProperty('__confirm');
    expect((gated?.inputSchema.properties as Record<string, { type: string }>).__confirm.type).toBe(
      'boolean',
    );
    // Not in `required` - the flag is optional; omitting it yields DRY_RUN_PREVIEW.
    expect((gated?.inputSchema.required as string[]) ?? []).not.toContain('__confirm');
    // Ungated tools must not advertise it.
    const ungated = tools.find((t) => t.name === 'messages_send');
    expect(ungated?.inputSchema.properties).not.toHaveProperty('__confirm');
  });

  it('publishes outputSchema for every tool that declares one', async () => {
    // Most tools declare an outputSchema; tools/list must emit it so clients can validate results.
    // so clients could not use it and nothing validated against it.
    const { tools } = await client.listTools();
    const withOutput = tools.filter((t) => t.outputSchema !== undefined);
    expect(withOutput.length).toBeGreaterThanOrEqual(191);
    const send = tools.find((t) => t.name === 'messages_send');
    expect(send?.outputSchema).toMatchObject({ type: 'object' });
    // Union with the error envelope, so a validating client accepts an
    // isError result instead of throwing on it.
    const arms = (send?.outputSchema as { anyOf?: unknown[] }).anyOf;
    expect(Array.isArray(arms)).toBe(true);
    expect(arms).toHaveLength(2);
  });

  it('returns an error result that satisfies the published error arm', async () => {
    // The regression this guards: emitting only the success schema turns every
    // isError result into a client-side McpError throw on SDK >= 1.20.
    const r = await client.callTool({ name: 'messages_send', arguments: {} });
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toMatchObject({
      code: expect.any(String),
      retriable: expect.any(Boolean),
      category: expect.stringMatching(/^(client|server)$/),
    });
  });

  it('lists 6 V2 resources via MCP resources/list', async () => {
    const { resources } = await client.listResources();
    expect(resources.length).toBe(6);
    expect(resources.map((r) => r.uri)).toContain('discord://components-v2/templates/announcement');
    expect(resources.map((r) => r.uri)).toContain('discord://components-v2/schema');
  });

  it('reads V2 announcement template via resources/read', async () => {
    const r = await client.readResource({ uri: 'discord://components-v2/templates/announcement' });
    expect(r.contents).toHaveLength(1);
    const c = r.contents[0]!;
    expect(c.mimeType).toBe('application/json');
    const text = c.text as string;
    const parsed = JSON.parse(text);
    expect(parsed.name).toBe('announcement');
  });

  it('registers and deregisters the URI on subscribe/unsubscribe', async () => {
    // Previously the only assertion-free test in the suite: it awaited both
    // calls and verified solely that the SDK did not reject, so gutting the
    // unsubscribe handler to a no-op still passed.
    const uri = 'discord://guild/999000999000999000/info';
    expect(subscriptions.has(uri)).toBe(false);
    await client.subscribeResource({ uri });
    expect(subscriptions.has(uri)).toBe(true);
    await client.unsubscribeResource({ uri });
    expect(subscriptions.has(uri)).toBe(false);
  });
});

/**
 * The authorization path for every destructive tool.
 *
 * `__confirm` is not declared by any tool inputSchema, so validateMiddleware -
 * which runs before preconditionMiddleware and replaces ctx.args with the
 * zod-parsed object - strips it. Before this suite existed the only coverage
 * was the negative case above, which passes whether the gate works or is
 * permanently closed. This asserts a confirm-gated tool can actually execute.
 *
 * MCP_DRY_RUN must be set before buildServer: the ConfirmRequired instance
 * captures process.env at construction time.
 */
describe('destructive tool authorization (MCP_DRY_RUN=false)', () => {
  const fakeEnv = {
    DISCORD_TOKEN: 'Bot fake.test.token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    LOG_LEVEL: 'fatal',
  } as NodeJS.ProcessEnv;

  let client: Client;
  const originalDryRun = process.env.MCP_DRY_RUN;

  beforeAll(async () => {
    process.env.MCP_DRY_RUN = 'false';
    const config = loadConfig(fakeEnv);
    const logger = createLogger(config);
    const rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token');
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const { server } = await buildServer({ rest, logger, config });
    client = new Client({ name: 'confirm-test', version: '0.0.0' }, { capabilities: {} });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  afterAll(async () => {
    await client.close();
    if (originalDryRun === undefined) {
      delete process.env.MCP_DRY_RUN;
    } else {
      process.env.MCP_DRY_RUN = originalDryRun;
    }
  });

  it('executes messages_delete when __confirm:true is passed', async () => {
    const r = await client.callTool({
      name: 'messages_delete',
      arguments: {
        channel_id: '111122223333444455',
        message_id: '999000999000999000',
        __confirm: true,
      },
    });
    expect(r.isError).toBe(false);
    expect(r.structuredContent).toMatchObject({
      deleted: true,
      message_id: '999000999000999000',
      channel_id: '111122223333444455',
    });
  });

  it('still previews when __confirm is omitted, even with MCP_DRY_RUN=false', async () => {
    const r = await client.callTool({
      name: 'messages_delete',
      arguments: { channel_id: '111122223333444455', message_id: '999000999000999000' },
    });
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toMatchObject({ code: 'DRY_RUN_PREVIEW' });
  });

  it('does not leak __confirm into the handler payload', async () => {
    // The preview echoes the validated args; __confirm must never appear there,
    // which also proves handlers never receive it.
    const r = await client.callTool({
      name: 'messages_delete',
      arguments: {
        channel_id: '111122223333444455',
        message_id: '999000999000999000',
        __confirm: false,
      },
    });
    expect(r.structuredContent).toMatchObject({ code: 'DRY_RUN_PREVIEW' });
    expect(JSON.stringify(r.structuredContent?.preview)).not.toContain('__confirm');
  });
});

describe('all-write preview authorization (MCP_WRITE_MODE=preview)', () => {
  const fakeEnv = {
    DISCORD_TOKEN: 'Bot fake.test.token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    LOG_LEVEL: 'fatal',
    MCP_WRITE_MODE: 'preview',
  } as NodeJS.ProcessEnv;

  let client: Client;

  beforeAll(async () => {
    const config = loadConfig(fakeEnv);
    const logger = createLogger(config);
    const rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token');
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const { server } = await buildServer({ rest, logger, config });
    client = new Client({ name: 'write-preview-test', version: '0.0.0' }, { capabilities: {} });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  afterAll(async () => {
    await client.close();
  });

  it('blocks a non-destructive write before the Discord handler', async () => {
    const r = await client.callTool({
      name: 'channels_create_guild_channel',
      arguments: { guild_id: '111122223333444455', name: 'preview-only' },
    });
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toMatchObject({
      code: 'WRITE_PREVIEW',
      tool: 'channels_create_guild_channel',
      preview: { guild_id: '111122223333444455', name: 'preview-only' },
    });
  });

  it('does not block read-only operations', async () => {
    const r = await client.callTool({
      name: 'channels_list',
      arguments: { guild_id: '111122223333444455' },
    });
    expect(r.isError).toBe(false);
  });
});
