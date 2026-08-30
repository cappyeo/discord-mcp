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
import { blueprintFingerprint, compileGuildBlueprint } from './_lib/blueprint.js';
import { encodeBlueprintPlan } from './_lib/blueprint.plan-token.js';
import { reconcileGuildBlueprint } from './_lib/blueprint.reconcile.js';
import type {
  BlueprintTargetSnapshot,
  TargetAutoModRule,
  TargetChannel,
  TargetMessage,
  TargetOnboarding,
  TargetRole,
  TargetWelcomeScreen,
} from './_lib/blueprint.target.js';

const API = 'https://discord.com/api/v10';
const GUILD_ID = '100000000000000001';
const BOT_ID = '100002088458902020';
const BOT_ROLE_ID = '100000000000000010';
const TOKEN = 'Bot full.graph.integration.token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

const blueprint = compileGuildBlueprint({
  request: 'Build a professional gaming community with LFG, voice rooms, and safe onboarding.',
  requested_capabilities: ['gaming', 'lfg', 'voice'],
  primary: {
    code: 'gaming-primary',
    effective_capabilities: ['gaming', 'lfg', 'voice'],
    blueprint: {
      channel_count: 10,
      category_count: 2,
      text_channel_count: 6,
      voice_channel_count: 3,
      forum_channel_count: 0,
      stage_channel_count: 0,
      other_channel_count: 0,
      nsfw_channel_count: 0,
      permission_overwrite_count: 4,
      role_count: 4,
      privileged_role_count: 0,
      risky_permission_signals: [],
    },
  },
  inspirations: [],
});
const BLUEPRINT_ID = blueprintFingerprint(blueprint);

function snowflake(offset: number): string {
  return String(200_000_000_000_000_000n + BigInt(offset));
}

function emptyTarget(): BlueprintTargetSnapshot {
  return {
    guild: {
      id: GUILD_ID,
      owner_id: snowflake(1),
      name: 'Nearly Empty Test Guild',
      description: null,
      preferred_locale: 'en-US',
      features: [],
      verification_level: 0,
      default_message_notifications: 0,
      explicit_content_filter: 0,
      rules_channel_id: null,
      public_updates_channel_id: null,
      safety_alerts_channel_id: null,
    },
    bot: { user: { id: BOT_ID }, roles: [BOT_ROLE_ID] },
    roles: [
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
        managed: true,
      },
    ],
    channels: [],
    automod_rules: [],
    onboarding: null,
    welcome_screen: null,
    recent_messages: {},
    publication_history_complete: {},
  };
}

type MutableTarget = {
  guild: BlueprintTargetSnapshot['guild'];
  roles: TargetRole[];
  channels: TargetChannel[];
  automodRules: TargetAutoModRule[];
  onboarding: TargetOnboarding | null;
  welcome: TargetWelcomeScreen | null;
  messages: Map<string, TargetMessage[]>;
};

function mutableTarget(): MutableTarget {
  const initial = emptyTarget();
  return {
    guild: { ...initial.guild },
    roles: initial.roles.map((role) => ({ ...role })),
    channels: [],
    automodRules: [],
    onboarding: null,
    welcome: null,
    messages: new Map(),
  };
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Expected Discord request body object.');
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function number(value: unknown, fallback = 0): number {
  return typeof value === 'number' ? value : fallback;
}

function boolean(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function array<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function asTargetChannel(body: Record<string, unknown>, id: string): TargetChannel {
  return {
    id,
    guild_id: GUILD_ID,
    name: string(body.name),
    type: number(body.type),
    position: number(body.position),
    parent_id: typeof body.parent_id === 'string' ? body.parent_id : null,
    topic: typeof body.topic === 'string' ? body.topic : null,
    nsfw: boolean(body.nsfw),
    rate_limit_per_user: number(body.rate_limit_per_user),
    bitrate: typeof body.bitrate === 'number' ? body.bitrate : undefined,
    user_limit: typeof body.user_limit === 'number' ? body.user_limit : undefined,
    permission_overwrites: array<TargetChannel['permission_overwrites'][number]>(
      body.permission_overwrites,
    ),
    available_tags: array<TargetChannel['available_tags'][number]>(body.available_tags),
  };
}

function onboardingResponse(body: Record<string, unknown>): TargetOnboarding {
  const prompts = array<Record<string, unknown>>(body.prompts).map((prompt, promptIndex) => ({
    ...prompt,
    id: string(prompt.id, snowflake(70_000 + promptIndex)),
    options: array<Record<string, unknown>>(prompt.options).map((option, optionIndex) => ({
      ...option,
      id: string(option.id, snowflake(71_000 + promptIndex * 100 + optionIndex)),
    })),
  }));
  return {
    guild_id: GUILD_ID,
    prompts,
    default_channel_ids: array<string>(body.default_channel_ids),
    enabled: boolean(body.enabled),
    mode: number(body.mode),
  };
}

afterEach(() => mockServer.resetHandlers());

describe('guild_blueprint_apply full graph MCP journey', () => {
  it('creates a professional guild from a nearly empty target, resumes after interruption, and converges without duplicates', async () => {
    const target = mutableTarget();
    const initial = reconcileGuildBlueprint(BLUEPRINT_ID, blueprint, emptyTarget());
    expect(initial.blockers).toEqual([]);
    expect(new Set(initial.operations.map((operation) => operation.resource))).toEqual(
      new Set([
        'role',
        'category',
        'channel',
        'guild',
        'channel_order',
        'welcome_screen',
        'onboarding',
        'automod_rule',
        'publication',
      ]),
    );
    const encoded = encodeBlueprintPlan(
      {
        schema_version: 'guild_blueprint_plan.v1',
        policy_version: 'safe-reconcile.v1',
        target: { guild_id: GUILD_ID, bot_id: BOT_ID },
        blueprint_id: BLUEPRINT_ID,
        blueprint,
        initial_snapshot_id: initial.snapshot_id,
        initial_bindings: initial.bindings,
        initial_operations: initial.operations,
        policy: {
          deletions: false,
          ambiguous_matches: 'block',
          unbound_drift: 'block',
          auto_grant_bot_permissions: false,
          managed_roles: 'immutable',
          publication_idempotency: 'marker_and_discord_nonce',
        },
      },
      TOKEN,
    );

    let nextId = 1_000;
    let failFirstAutoModCreate = true;
    const creates = {
      roles: 0,
      categories: 0,
      channels: 0,
      automod: 0,
      publications: 0,
      guild: 0,
      welcome: 0,
      onboarding: 0,
      roleOrder: 0,
      channelOrder: 0,
    };
    const mutations = new Map<string, number>();
    const mutation = (key: string): void => {
      mutations.set(key, (mutations.get(key) ?? 0) + 1);
    };

    mockServer.use(
      http.get(`${API}/users/@me`, () =>
        HttpResponse.json({ id: BOT_ID, username: 'DevBot', bot: true }),
      ),
      http.get(`${API}/guilds/:guildId/members/:botId`, () =>
        HttpResponse.json({ user: { id: BOT_ID }, roles: [BOT_ROLE_ID] }),
      ),
      http.get(`${API}/guilds/:guildId`, () => HttpResponse.json(target.guild)),
      http.get(`${API}/guilds/:guildId/roles`, () => HttpResponse.json(target.roles)),
      http.get(`${API}/guilds/:guildId/channels`, () => HttpResponse.json(target.channels)),
      http.get(`${API}/guilds/:guildId/auto-moderation/rules`, () =>
        HttpResponse.json(target.automodRules),
      ),
      http.get(`${API}/guilds/:guildId/onboarding`, () =>
        target.onboarding === null
          ? HttpResponse.json({ message: 'Unknown Onboarding' }, { status: 404 })
          : HttpResponse.json(target.onboarding),
      ),
      http.get(`${API}/guilds/:guildId/welcome-screen`, () =>
        target.welcome === null
          ? HttpResponse.json({ message: 'Unknown Welcome Screen' }, { status: 404 })
          : HttpResponse.json(target.welcome),
      ),
      http.get(`${API}/channels/:channelId/messages/:messageId`, ({ params }) => {
        const message = (target.messages.get(String(params.channelId)) ?? []).find(
          (candidate) => candidate.id === String(params.messageId),
        );
        return message === undefined
          ? HttpResponse.json({ message: 'Unknown Message' }, { status: 404 })
          : HttpResponse.json(message);
      }),
      http.get(`${API}/channels/:channelId/messages`, ({ params }) =>
        HttpResponse.json(target.messages.get(String(params.channelId)) ?? []),
      ),
      http.post(`${API}/guilds/:guildId/roles`, async ({ request }) => {
        mutation('role:create');
        creates.roles += 1;
        const body = object(await request.json());
        const role: TargetRole = {
          id: snowflake(nextId++),
          name: string(body.name),
          color: number(body.color),
          // Discord creates new roles at the same low position. Equal-position
          // snowflake ordering then preserves the reverse desired create order.
          position: 1,
          permissions: string(body.permissions),
          mentionable: boolean(body.mentionable),
          hoist: boolean(body.hoist),
          managed: false,
        };
        target.roles.push(role);
        return HttpResponse.json(role);
      }),
      http.post(`${API}/guilds/:guildId/channels`, async ({ request }) => {
        const body = object(await request.json());
        const channel = asTargetChannel(body, snowflake(nextId++));
        target.channels.push(channel);
        if (channel.type === 4) creates.categories += 1;
        else creates.channels += 1;
        mutation(channel.type === 4 ? 'category:create' : 'channel:create');
        return HttpResponse.json(channel);
      }),
      http.patch(`${API}/guilds/:guildId/roles`, async ({ request }) => {
        mutation('role:order');
        creates.roleOrder += 1;
        for (const position of array<Record<string, unknown>>(await request.json())) {
          const role = target.roles.find((candidate) => candidate.id === string(position.id));
          if (role !== undefined) role.position = number(position.position);
        }
        return HttpResponse.json(target.roles);
      }),
      http.patch(`${API}/guilds/:guildId/channels`, async ({ request }) => {
        mutation('channel:order');
        creates.channelOrder += 1;
        for (const position of array<Record<string, unknown>>(await request.json())) {
          const channel = target.channels.find((candidate) => candidate.id === string(position.id));
          if (channel === undefined) continue;
          channel.position = number(position.position);
          if (Object.hasOwn(position, 'parent_id')) {
            channel.parent_id = typeof position.parent_id === 'string' ? position.parent_id : null;
          }
        }
        return new HttpResponse(null, { status: 204 });
      }),
      http.patch(`${API}/guilds/:guildId`, async ({ request }) => {
        mutation('guild:update');
        creates.guild += 1;
        const body = object(await request.json());
        target.guild = {
          ...target.guild,
          name: string(body.name, target.guild.name),
          description: typeof body.description === 'string' ? body.description : null,
          preferred_locale: string(body.preferred_locale, target.guild.preferred_locale),
          features: array<string>(body.features),
          verification_level: number(body.verification_level, target.guild.verification_level),
          default_message_notifications: number(
            body.default_message_notifications,
            target.guild.default_message_notifications,
          ),
          explicit_content_filter: number(
            body.explicit_content_filter,
            target.guild.explicit_content_filter,
          ),
          rules_channel_id:
            typeof body.rules_channel_id === 'string' ? body.rules_channel_id : null,
          public_updates_channel_id:
            typeof body.public_updates_channel_id === 'string'
              ? body.public_updates_channel_id
              : null,
          safety_alerts_channel_id:
            typeof body.safety_alerts_channel_id === 'string'
              ? body.safety_alerts_channel_id
              : null,
        };
        return HttpResponse.json(target.guild);
      }),
      http.patch(`${API}/guilds/:guildId/welcome-screen`, async ({ request }) => {
        mutation('welcome:update');
        creates.welcome += 1;
        const body = object(await request.json());
        if (boolean(body.enabled)) {
          target.guild.features = [
            ...new Set([...target.guild.features, 'WELCOME_SCREEN_ENABLED']),
          ];
        }
        target.welcome = {
          description: typeof body.description === 'string' ? body.description : null,
          welcome_channels: array<TargetWelcomeScreen['welcome_channels'][number]>(
            body.welcome_channels,
          ),
        };
        return HttpResponse.json(target.welcome);
      }),
      http.put(`${API}/guilds/:guildId/onboarding`, async ({ request }) => {
        mutation('onboarding:update');
        creates.onboarding += 1;
        target.onboarding = onboardingResponse(object(await request.json()));
        return HttpResponse.json(target.onboarding);
      }),
      http.post(`${API}/guilds/:guildId/auto-moderation/rules`, async ({ request }) => {
        mutation('automod:create');
        if (failFirstAutoModCreate) {
          failFirstAutoModCreate = false;
          return HttpResponse.json({ message: 'synthetic interruption' }, { status: 500 });
        }
        creates.automod += 1;
        const body = object(await request.json());
        const rule: TargetAutoModRule = {
          id: snowflake(nextId++),
          guild_id: GUILD_ID,
          creator_id: BOT_ID,
          name: string(body.name),
          event_type: number(body.event_type),
          trigger_type: number(body.trigger_type),
          trigger_metadata: object(body.trigger_metadata),
          actions: array<Record<string, unknown>>(body.actions),
          enabled: boolean(body.enabled),
          exempt_roles: array<string>(body.exempt_roles),
          exempt_channels: array<string>(body.exempt_channels),
        };
        target.automodRules.push(rule);
        return HttpResponse.json(rule);
      }),
      http.post(`${API}/channels/:channelId/messages`, async ({ params, request }) => {
        mutation('publication:create');
        creates.publications += 1;
        const body = object(await request.json());
        const channelId = String(params.channelId);
        const message: TargetMessage = {
          id: snowflake(nextId++),
          channel_id: channelId,
          guild_id: GUILD_ID,
          author: { id: BOT_ID },
          flags: number(body.flags),
          nonce: typeof body.nonce === 'string' ? body.nonce : undefined,
          mention_everyone: false,
          mentions: [],
          mention_roles: [],
          components: array<unknown>(body.components),
        };
        target.messages.set(channelId, [message, ...(target.messages.get(channelId) ?? [])]);
        return HttpResponse.json(message);
      }),
    );

    const stateDirectory = await mkdtemp(join(tmpdir(), 'discord-mcp-apply-full-graph-'));
    const originalDryRun = process.env.MCP_DRY_RUN;
    process.env.MCP_DRY_RUN = 'false';
    let client: Client | undefined;
    try {
      const config = loadConfig({
        DISCORD_TOKEN: TOKEN,
        DISCORD_EXPECTED_BOT_ID: BOT_ID,
        ALLOWED_GUILDS: GUILD_ID,
        MCP_BLUEPRINT_STATE_DIR: stateDirectory,
        LOG_LEVEL: 'fatal',
        MCP_AUDIT_ENABLED: 'false',
      });
      const rest = new REST({ version: '10', retries: 0, makeRequest: fetch }).setToken(TOKEN);
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const built = await buildServer({ rest, logger: createLogger(config), config });
      client = new Client(
        { name: 'blueprint-full-graph-test', version: '0.0.0' },
        { capabilities: {} },
      );
      await Promise.all([built.server.connect(serverTransport), client.connect(clientTransport)]);

      const args = {
        guild_id: GUILD_ID,
        expected_bot_id: BOT_ID,
        plan_token: encoded.plan_token,
        approval_id: encoded.approval_id,
        operation_budget: 50,
        __confirm: true,
      };
      const first = await client.callTool({ name: 'guild_blueprint_apply', arguments: args });
      expect(first.structuredContent).toMatchObject({
        status: 'partial',
        error: { code: 'DISCORD_API_ERROR', retriable: true, status: 500 },
        evidence: { activity: null },
        next_action: 'resume',
      });
      expect(creates.roles).toBe(blueprint.roles.length);
      expect(creates.categories).toBe(blueprint.categories.length);
      expect(creates.channels).toBe(blueprint.channels.length);
      expect(creates.guild).toBe(1);
      expect(creates.roleOrder).toBe(0);
      expect(creates.channelOrder).toBe(1);
      expect(creates.welcome).toBe(1);
      expect(creates.onboarding).toBe(1);
      expect(creates.automod).toBe(0);
      expect(creates.publications).toBe(0);

      const resumed = await client.callTool({ name: 'guild_blueprint_apply', arguments: args });
      expect(resumed.structuredContent).toMatchObject({
        status: 'complete',
        progress: { remaining: 0 },
        evidence: {
          readback: 'match',
          checkpoint_persisted: true,
          activity: {
            schema_version: 'guild_blueprint_activity_evidence.v1',
            plan_invariants: {
              expected_counts: {
                identity: 2,
                roles: blueprint.roles.length,
                categories: blueprint.categories.length,
                channels: blueprint.channels.length,
                automod: blueprint.automod.rules.length,
                components_v2: blueprint.components_v2.publications.length,
              },
              safety_policy: {
                source_permissions_applied: false,
                dangerous_generated_permissions: 0,
                bot_permission_grants: 0,
                discord_managed_role_mutations: 0,
              },
            },
          },
        },
        next_action: 'done',
      });
      const resumedEvidence = object(object(resumed.structuredContent).evidence);
      const activityEvidenceId = string(object(resumedEvidence.activity).evidence_id);
      expect(activityEvidenceId).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(creates.automod).toBe(blueprint.automod.rules.length);
      expect(creates.publications).toBe(blueprint.components_v2.publications.length);
      expect(target.roles).toHaveLength(2 + blueprint.roles.length);
      expect(target.channels).toHaveLength(blueprint.categories.length + blueprint.channels.length);
      expect(target.automodRules).toHaveLength(blueprint.automod.rules.length);
      expect([...target.messages.values()].flat()).toHaveLength(
        blueprint.components_v2.publications.length,
      );

      const replay = await client.callTool({ name: 'guild_blueprint_apply', arguments: args });
      expect(replay.structuredContent).toMatchObject({
        status: 'already_current',
        evidence: { activity: { evidence_id: activityEvidenceId } },
        next_action: 'done',
      });
      expect(creates).toEqual({
        roles: blueprint.roles.length,
        categories: blueprint.categories.length,
        channels: blueprint.channels.length,
        automod: blueprint.automod.rules.length,
        publications: blueprint.components_v2.publications.length,
        guild: 1,
        welcome: 1,
        onboarding: 1,
        roleOrder: 0,
        channelOrder: 1,
      });
      expect(mutations.get('automod:create')).toBe(blueprint.automod.rules.length + 1);

      await client.close();
      client = undefined;
      const restartedRest = new REST({ version: '10', retries: 0, makeRequest: fetch }).setToken(
        TOKEN,
      );
      const [restartedClientTransport, restartedServerTransport] =
        InMemoryTransport.createLinkedPair();
      const restarted = await buildServer({
        rest: restartedRest,
        logger: createLogger(config),
        config,
      });
      client = new Client(
        { name: 'blueprint-evidence-restart-test', version: '0.0.0' },
        { capabilities: {} },
      );
      await Promise.all([
        restarted.server.connect(restartedServerTransport),
        client.connect(restartedClientTransport),
      ]);

      const afterRestart = await client.callTool({
        name: 'guild_blueprint_evidence',
        arguments: {
          guild_id: GUILD_ID,
          expected_bot_id: BOT_ID,
          plan_id: encoded.plan_id,
        },
      });
      expect(afterRestart.structuredContent).toMatchObject({
        status: 'verified',
        plan_id: encoded.plan_id,
        blueprint_id: BLUEPRINT_ID,
        evidence_id: activityEvidenceId,
        verification: {
          identity_verified: true,
          guild_verified: true,
          readback: 'match',
          snapshot_unchanged: true,
          remaining_operations: [],
          blockers: [],
        },
      });
      expect(creates).toEqual({
        roles: blueprint.roles.length,
        categories: blueprint.categories.length,
        channels: blueprint.channels.length,
        automod: blueprint.automod.rules.length,
        publications: blueprint.components_v2.publications.length,
        guild: 1,
        welcome: 1,
        onboarding: 1,
        roleOrder: 0,
        channelOrder: 1,
      });

      await writeFile(
        join(stateDirectory, encoded.plan_id.slice('sha256:'.length), 'activity-evidence.json'),
        '{"schema_version":"tampered"}\n',
        'utf8',
      );
      const tamperedReplay = await client.callTool({
        name: 'guild_blueprint_apply',
        arguments: args,
      });
      expect(tamperedReplay.structuredContent).toMatchObject({
        status: 'partial',
        error: { code: 'EVIDENCE_MALFORMED', retriable: false },
        evidence: { activity: null },
        next_action: 'fix_configuration',
      });
      expect(creates).toEqual({
        roles: blueprint.roles.length,
        categories: blueprint.categories.length,
        channels: blueprint.channels.length,
        automod: blueprint.automod.rules.length,
        publications: blueprint.components_v2.publications.length,
        guild: 1,
        welcome: 1,
        onboarding: 1,
        roleOrder: 0,
        channelOrder: 1,
      });
    } finally {
      await client?.close();
      await rm(stateDirectory, { recursive: true, force: true });
      if (originalDryRun === undefined) delete process.env.MCP_DRY_RUN;
      else process.env.MCP_DRY_RUN = originalDryRun;
    }
  }, 30_000);
});
