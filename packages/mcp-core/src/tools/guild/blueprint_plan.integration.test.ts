import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { server as mockServer } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { HttpResponse, http } from 'msw';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../config.js';
import { createLogger } from '../../logger.js';
import { buildServer } from '../../server.js';
import { loadBlueprintPlanReference } from './_lib/blueprint.plan-reference-store.js';

const API = 'https://discord.com/api/v10';
const GUILD_ID = '100000000000000001';
const OTHER_GUILD_ID = '100000000000000002';
const BOT_ID = '100002088458902020';
const BOT_ROLE_ID = '100000000000000010';
const TEMPLATE_CODE = 'WNSCpfHWnqXr';
const TOKEN = 'Bot plan.integration.token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function template(code: string) {
  return {
    code,
    name: 'Gaming community blueprint source',
    description: 'A public gaming template used as untrusted structural inspiration.',
    usage_count: 42,
    creator_id: '111122223333444455',
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: '2026-08-02T00:00:00.000Z',
    source_guild_id: '999000999000999000',
    is_dirty: false,
    serialized_source_guild: {
      channels: [
        { id: '1', name: 'Welcome', type: 4 },
        { id: '2', name: 'Looking for group', type: 0 },
        { id: '3', name: 'PC', type: 0 },
        { id: '4', name: 'Events', type: 15 },
        { id: '5', name: 'General voice', type: 2 },
      ],
      roles: [
        { id: '0', name: '@everyone', permissions: '0' },
        { id: '1', name: 'Member', permissions: '0' },
      ],
    },
  };
}

describe('guild_blueprint_plan public MCP journey', () => {
  afterEach(() => mockServer.resetHandlers());

  it('turns one natural-language request into an authenticated target-bound dry-run without writes', async () => {
    let templateReads = 0;
    let mutations = 0;
    mockServer.use(
      http.get(`${API}/guilds/templates/:code`, ({ params }) => {
        templateReads += 1;
        return HttpResponse.json(template(String(params.code)));
      }),
      http.get(`${API}/users/@me`, () =>
        HttpResponse.json({ id: BOT_ID, username: 'DevBot', bot: true }),
      ),
      http.get(`${API}/guilds/:guildId`, ({ params }) =>
        HttpResponse.json({
          id: String(params.guildId),
          name: 'Empty Gaming Test Guild',
          owner_id: '100000000000000099',
          description: null,
          preferred_locale: 'en-US',
          features: [],
          verification_level: 0,
          default_message_notifications: 0,
          explicit_content_filter: 0,
          rules_channel_id: null,
          public_updates_channel_id: null,
          safety_alerts_channel_id: null,
        }),
      ),
      http.get(`${API}/guilds/:guildId/members/:userId`, ({ params }) =>
        HttpResponse.json({ user: { id: String(params.userId) }, roles: [BOT_ROLE_ID] }),
      ),
      http.get(`${API}/guilds/:guildId/roles`, ({ params }) =>
        HttpResponse.json([
          {
            id: String(params.guildId),
            name: '@everyone',
            color: 0,
            position: 0,
            permissions: '0',
            mentionable: false,
            hoist: false,
            managed: false,
          },
          {
            id: BOT_ROLE_ID,
            name: 'DevBot',
            color: 0,
            position: 100,
            permissions: '8',
            mentionable: false,
            hoist: false,
            managed: false,
          },
        ]),
      ),
      http.get(`${API}/guilds/:guildId/channels`, () => HttpResponse.json([])),
      http.get(`${API}/guilds/:guildId/auto-moderation/rules`, () => HttpResponse.json([])),
      http.get(`${API}/channels/:channelId/messages`, () => HttpResponse.json([])),
      http.all(`${API}/guilds/:guildId/:rest*`, () => {
        mutations += 1;
        return HttpResponse.json({ message: 'unexpected Discord mutation' }, { status: 500 });
      }),
      http.all(`${API}/channels/:channelId/:rest*`, () => {
        mutations += 1;
        return HttpResponse.json({ message: 'unexpected Discord mutation' }, { status: 500 });
      }),
    );

    const stateDirectory = await mkdtemp(join(tmpdir(), 'discord-mcp-plan-integration-'));
    try {
      const config = loadConfig({
        DISCORD_TOKEN: TOKEN,
        DISCORD_EXPECTED_BOT_ID: BOT_ID,
        ALLOWED_GUILDS: GUILD_ID,
        MCP_BLUEPRINT_STATE_DIR: stateDirectory,
        MCP_TOOL_SURFACE: 'progressive',
        LOG_LEVEL: 'fatal',
        MCP_AUDIT_ENABLED: 'false',
      });
      const rest = new REST({ version: '10', retries: 0, makeRequest: fetch }).setToken(TOKEN);
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const built = await buildServer({ rest, logger: createLogger(config), config });
      const client = new Client(
        { name: 'blueprint-plan-integration', version: '0.0.0' },
        { capabilities: {} },
      );
      await Promise.all([built.server.connect(serverTransport), client.connect(clientTransport)]);
      try {
        const result = await client.callTool({
          name: 'build_discord_server',
          arguments: {
            request: 'Dựng cho tôi một server gaming chuyên nghiệp có tìm đồng đội và voice',
            preferred_primary_code: TEMPLATE_CODE,
          },
        });
        expect(result.isError).toBe(false);
        expect(result.structuredContent).toMatchObject({
          status: 'ready',
          target: { guild_id: GUILD_ID, bot_id: BOT_ID },
          source: { primary: { code: TEMPLATE_CODE } },
          blueprint_id: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
          snapshot_id: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
          plan_id: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
          approval_id: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
          plan_ref: expect.stringMatching(/^dmbpr1\.[a-f0-9]{64}$/),
          plan_token: expect.stringMatching(
            /^dmbp1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/,
          ),
          verification: { blueprint_validation: 'passed', target_readback: 'passed' },
        });
        expect(result.structuredContent?.operations).toEqual(expect.any(Array));
        const content = result.structuredContent as {
          plan_id: string;
          plan_ref: string;
          plan_token: string;
        };
        const text = result.content.find((block) => block.type === 'text')?.text ?? '';
        expect(text).toContain('MCP_BLUEPRINT_RECEIPT ');
        expect(text).toContain('"phase":"plan"');
        expect(text).toContain(`"plan_id":"${content.plan_id}"`);
        expect(text).toContain(`"plan_ref":"${content.plan_ref}"`);
        expect(text).not.toContain(content.plan_token);
        const loaded = await loadBlueprintPlanReference({
          stateDirectory,
          planRef: content.plan_ref,
          signingSecret: TOKEN,
        });
        expect(loaded.plan_id).toBe(content.plan_id);
        expect(loaded.payload.target).toEqual({ guild_id: GUILD_ID, bot_id: BOT_ID });
        expect(templateReads).toBeGreaterThan(0);
        expect(templateReads).toBeLessThanOrEqual(8);
        expect(mutations).toBe(0);
      } finally {
        await client.close();
      }
    } finally {
      await rm(stateDirectory, { recursive: true, force: true });
    }
  });

  it('keeps a ready plan usable with the legacy token when local reference storage fails', async () => {
    let mutations = 0;
    mockServer.use(
      http.get(`${API}/guilds/templates/:code`, ({ params }) =>
        HttpResponse.json(template(String(params.code))),
      ),
      http.get(`${API}/users/@me`, () => HttpResponse.json({ id: BOT_ID, bot: true })),
      http.get(`${API}/guilds/:guildId`, ({ params }) =>
        HttpResponse.json({
          id: String(params.guildId),
          name: 'Invalid State Path Guild',
          owner_id: '100000000000000099',
          description: null,
          preferred_locale: 'en-US',
          features: [],
          verification_level: 0,
          default_message_notifications: 0,
          explicit_content_filter: 0,
          rules_channel_id: null,
          public_updates_channel_id: null,
          safety_alerts_channel_id: null,
        }),
      ),
      http.get(`${API}/guilds/:guildId/members/:userId`, () =>
        HttpResponse.json({ user: { id: BOT_ID }, roles: [BOT_ROLE_ID] }),
      ),
      http.get(`${API}/guilds/:guildId/roles`, () =>
        HttpResponse.json([
          {
            id: GUILD_ID,
            name: '@everyone',
            color: 0,
            position: 0,
            permissions: '0',
            mentionable: false,
            hoist: false,
            managed: false,
          },
          {
            id: BOT_ROLE_ID,
            name: 'DevBot',
            color: 0,
            position: 100,
            permissions: '8',
            mentionable: false,
            hoist: false,
            managed: false,
          },
        ]),
      ),
      http.get(`${API}/guilds/:guildId/channels`, () => HttpResponse.json([])),
      http.get(`${API}/guilds/:guildId/auto-moderation/rules`, () => HttpResponse.json([])),
      http.get(`${API}/channels/:channelId/messages`, () => HttpResponse.json([])),
      http.all(`${API}/guilds/:guildId/:rest*`, () => {
        mutations += 1;
        return HttpResponse.json({ message: 'unexpected Discord mutation' }, { status: 500 });
      }),
      http.all(`${API}/channels/:channelId/:rest*`, () => {
        mutations += 1;
        return HttpResponse.json({ message: 'unexpected Discord mutation' }, { status: 500 });
      }),
    );

    const stateRoot = await mkdtemp(join(tmpdir(), 'discord-mcp-invalid-state-'));
    const invalidStatePath = join(stateRoot, 'state-file');
    await writeFile(invalidStatePath, 'not a directory', 'utf8');
    try {
      const config = loadConfig({
        DISCORD_TOKEN: TOKEN,
        DISCORD_EXPECTED_BOT_ID: BOT_ID,
        ALLOWED_GUILDS: GUILD_ID,
        MCP_BLUEPRINT_STATE_DIR: invalidStatePath,
        MCP_TOOL_SURFACE: 'progressive',
        LOG_LEVEL: 'fatal',
        MCP_AUDIT_ENABLED: 'false',
      });
      const rest = new REST({ version: '10', retries: 0, makeRequest: fetch }).setToken(TOKEN);
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const built = await buildServer({ rest, logger: createLogger(config), config });
      const client = new Client(
        { name: 'blueprint-plan-invalid-state-test', version: '0.0.0' },
        { capabilities: {} },
      );
      await Promise.all([built.server.connect(serverTransport), client.connect(clientTransport)]);
      try {
        const result = await client.callTool({
          name: 'build_discord_server',
          arguments: {
            request: 'Dựng cho tôi một server gaming chuyên nghiệp',
            preferred_primary_code: TEMPLATE_CODE,
          },
        });
        expect(result.isError).toBe(false);
        expect(result.structuredContent).toMatchObject({
          status: 'ready',
          plan_ref: null,
          plan_token: expect.stringMatching(
            /^dmbp1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/,
          ),
        });
        expect(result.structuredContent?.warnings).toEqual(
          expect.arrayContaining([
            expect.stringContaining('private local plan reference could not be persisted'),
          ]),
        );
        expect(mutations).toBe(0);
      } finally {
        await client.close();
      }
    } finally {
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  it('blocks an unexpected bot before reading templates or the target guild', async () => {
    let templateReads = 0;
    let targetReads = 0;
    mockServer.use(
      http.get(`${API}/guilds/templates/:code`, () => {
        templateReads += 1;
        return HttpResponse.json(template(TEMPLATE_CODE));
      }),
      http.get(`${API}/users/@me`, () => HttpResponse.json({ id: BOT_ID, bot: true })),
      http.get(`${API}/guilds/:guildId`, () => {
        targetReads += 1;
        return HttpResponse.json({ id: GUILD_ID });
      }),
    );
    const config = loadConfig({
      DISCORD_TOKEN: TOKEN,
      DISCORD_EXPECTED_BOT_ID: BOT_ID,
      ALLOWED_GUILDS: GUILD_ID,
      MCP_TOOL_SURFACE: 'progressive',
      LOG_LEVEL: 'fatal',
      MCP_AUDIT_ENABLED: 'false',
    });
    const rest = new REST({ version: '10', retries: 0, makeRequest: fetch }).setToken(TOKEN);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const built = await buildServer({ rest, logger: createLogger(config), config });
    const client = new Client(
      { name: 'blueprint-plan-lock-test', version: '0.0.0' },
      { capabilities: {} },
    );
    await Promise.all([built.server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const result = await client.callTool({
        name: 'build_discord_server',
        arguments: {
          guild_id: GUILD_ID,
          expected_bot_id: '100002088458902099',
          request: 'Build a gaming server',
          preferred_primary_code: TEMPLATE_CODE,
        },
      });
      expect(result.structuredContent).toMatchObject({
        status: 'blocked',
        blockers: [expect.objectContaining({ code: 'EXPECTED_BOT_MISMATCH' })],
      });
      expect(templateReads).toBe(0);
      expect(targetReads).toBe(0);
    } finally {
      await client.close();
    }
  });

  it('requires an explicit guild before Discord access when the profile allows several', async () => {
    let targetReads = 0;
    mockServer.use(
      http.get(`${API}/users/@me`, () =>
        HttpResponse.json({ id: BOT_ID, username: 'DevBot', bot: true }),
      ),
      http.all(`${API}/guilds/:rest*`, () => {
        targetReads += 1;
        return HttpResponse.json({ message: 'unexpected target access' }, { status: 500 });
      }),
    );
    const config = loadConfig({
      DISCORD_TOKEN: TOKEN,
      DISCORD_EXPECTED_BOT_ID: BOT_ID,
      ALLOWED_GUILDS: `${GUILD_ID},${OTHER_GUILD_ID}`,
      MCP_TOOL_SURFACE: 'progressive',
      LOG_LEVEL: 'fatal',
      MCP_AUDIT_ENABLED: 'false',
    });
    const rest = new REST({ version: '10', retries: 0, makeRequest: fetch }).setToken(TOKEN);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const built = await buildServer({ rest, logger: createLogger(config), config });
    const client = new Client(
      { name: 'blueprint-plan-target-selection-test', version: '0.0.0' },
      { capabilities: {} },
    );
    await Promise.all([built.server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const result = await client.callTool({
        name: 'build_discord_server',
        arguments: { request: 'Build a gaming server' },
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        code: 'VALIDATION_FAILED',
        issues: [expect.objectContaining({ code: 'target_selection_required' })],
      });
      expect(targetReads).toBe(0);
    } finally {
      await client.close();
    }
  });
});
