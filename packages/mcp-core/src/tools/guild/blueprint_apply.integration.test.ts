import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { server as mockServer } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../config.js';
import { createLogger } from '../../logger.js';
import { buildServer } from '../../server.js';
import {
  desiredAutoModBody,
  desiredCategoryBody,
  desiredChannelBody,
  desiredGuildBody,
  desiredOnboardingBody,
  desiredPublicationBody,
  desiredRoleBody,
  desiredWelcomeBody,
} from './_lib/blueprint.desired.js';
import type { BlueprintBindings } from './_lib/blueprint.execution.schema.js';
import { emptyBlueprintBindings } from './_lib/blueprint.execution.schema.js';
import { blueprintFingerprint, compileGuildBlueprint } from './_lib/blueprint.js';
import { saveBlueprintPlanReference } from './_lib/blueprint.plan-reference-store.js';
import { encodeBlueprintPlan } from './_lib/blueprint.plan-token.js';
import { reconcileGuildBlueprint } from './_lib/blueprint.reconcile.js';
import type {
  BlueprintTargetSnapshot,
  TargetAutoModRule,
  TargetChannel,
  TargetMessage,
  TargetRole,
} from './_lib/blueprint.target.js';

const API = 'https://discord.com/api/v10';
const GUILD_ID = '100000000000000001';
const BOT_ID = '100002088458902020';
const BOT_ROLE_ID = '100000000000000010';
const SIGNING_TOKEN = 'Bot test.profile.token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

const blueprint = compileGuildBlueprint({
  request: 'Build a professional gaming community',
  requested_capabilities: ['gaming', 'lfg', 'voice'],
  primary: {
    code: 'primary',
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

function buildConvergedFixture() {
  const bindings: BlueprintBindings = emptyBlueprintBindings();
  blueprint.roles.forEach((role, index) => {
    bindings.roles[role.key] = snowflake(100 + index);
  });
  blueprint.categories.forEach((category, index) => {
    bindings.categories[category.key] = snowflake(200 + index);
  });
  blueprint.channels.forEach((channel, index) => {
    bindings.channels[channel.key] = snowflake(300 + index);
  });
  blueprint.automod.rules.forEach((rule, index) => {
    bindings.automod_rules[rule.key] = snowflake(400 + index);
  });
  blueprint.components_v2.publications.forEach((publication, index) => {
    bindings.publications[publication.key] = snowflake(500 + index);
  });

  const everyone: TargetRole = {
    id: GUILD_ID,
    name: '@everyone',
    color: 0,
    position: 0,
    permissions: '0',
    mentionable: false,
    hoist: false,
    managed: false,
  };
  const botRole: TargetRole = {
    id: BOT_ROLE_ID,
    name: 'DevBot',
    color: 0,
    position: 100,
    permissions: '8',
    mentionable: false,
    hoist: false,
    managed: false,
  };
  const roles: TargetRole[] = [
    everyone,
    ...blueprint.role_order.map((key, index) => {
      const desired = blueprint.roles.find((role) => role.key === key)!;
      const body = desiredRoleBody(desired);
      return {
        id: bindings.roles[key]!,
        name: body.name as string,
        color: body.color as number,
        position: index + 1,
        permissions: body.permissions as string,
        mentionable: body.mentionable as boolean,
        hoist: body.hoist as boolean,
        managed: false,
      };
    }),
    botRole,
  ];

  const categories: TargetChannel[] = blueprint.categories.map((category) => {
    const body = desiredCategoryBody(category, GUILD_ID, BOT_ID, bindings)!;
    return {
      id: bindings.categories[category.key]!,
      guild_id: GUILD_ID,
      name: body.name as string,
      type: body.type as number,
      position: body.position as number,
      parent_id: null,
      topic: null,
      nsfw: false,
      rate_limit_per_user: 0,
      permission_overwrites: (body.permission_overwrites ??
        []) as TargetChannel['permission_overwrites'],
      available_tags: [],
    };
  });
  const channels: TargetChannel[] = blueprint.channels.map((channel) => {
    const body = desiredChannelBody(channel, GUILD_ID, BOT_ID, bindings)!;
    return {
      id: bindings.channels[channel.key]!,
      guild_id: GUILD_ID,
      name: body.name as string,
      type: body.type as number,
      position: body.position as number,
      parent_id: body.parent_id as string,
      topic: (body.topic as string | undefined) ?? null,
      nsfw: body.nsfw as boolean,
      rate_limit_per_user: body.rate_limit_per_user as number,
      permission_overwrites: (body.permission_overwrites ??
        []) as TargetChannel['permission_overwrites'],
      available_tags: (body.available_tags ?? []) as TargetChannel['available_tags'],
    };
  });

  const features = ['COMMUNITY', 'WELCOME_SCREEN_ENABLED'];
  const guildBody = desiredGuildBody(blueprint, features, bindings)!;
  const guild = {
    id: GUILD_ID,
    owner_id: snowflake(3),
    name: guildBody.name as string,
    description: guildBody.description as string,
    preferred_locale: guildBody.preferred_locale as string,
    features: guildBody.features as string[],
    verification_level: guildBody.verification_level as number,
    default_message_notifications: guildBody.default_message_notifications as number,
    explicit_content_filter: guildBody.explicit_content_filter as number,
    rules_channel_id: guildBody.rules_channel_id as string,
    public_updates_channel_id: guildBody.public_updates_channel_id as string,
    safety_alerts_channel_id: guildBody.safety_alerts_channel_id as string,
  };
  const onboardingBody = desiredOnboardingBody(blueprint, bindings)!;
  const onboarding = {
    guild_id: GUILD_ID,
    prompts: onboardingBody.prompts as Array<Record<string, unknown>>,
    default_channel_ids: onboardingBody.default_channel_ids as string[],
    enabled: onboardingBody.enabled as boolean,
    mode: onboardingBody.mode as number,
  };
  const welcome = desiredWelcomeBody(blueprint, bindings)! as unknown as {
    description: string | null;
    welcome_channels: Array<{
      channel_id: string;
      description: string;
      emoji_id: string | null;
      emoji_name: string | null;
    }>;
  };
  const automodRules: TargetAutoModRule[] = blueprint.automod.rules.map((rule) => ({
    id: bindings.automod_rules[rule.key]!,
    guild_id: GUILD_ID,
    creator_id: BOT_ID,
    ...(desiredAutoModBody(rule, bindings)! as Omit<
      TargetAutoModRule,
      'id' | 'guild_id' | 'creator_id'
    >),
  }));

  const messages = new Map<string, TargetMessage[]>();
  for (const publication of blueprint.components_v2.publications) {
    const desired = desiredPublicationBody(publication, BLUEPRINT_ID, GUILD_ID, BOT_ID, bindings)!;
    const current = messages.get(desired.channel_id) ?? [];
    current.push({
      id: bindings.publications[publication.key]!,
      channel_id: desired.channel_id,
      author: { id: BOT_ID },
      flags: desired.body.flags as number,
      nonce: desired.body.nonce as string,
      mention_everyone: false,
      mentions: [],
      mention_roles: [],
      components: desired.body.components as unknown[],
    });
    messages.set(desired.channel_id, current);
  }

  return {
    bindings,
    roles,
    categories,
    channels,
    guild,
    onboarding,
    welcome,
    automodRules,
    messages,
  };
}

function snapshotFrom(fixture: ReturnType<typeof buildConvergedFixture>): BlueprintTargetSnapshot {
  return {
    guild: fixture.guild,
    bot: { user: { id: BOT_ID }, roles: [BOT_ROLE_ID] },
    roles: fixture.roles,
    channels: [...fixture.categories, ...fixture.channels],
    automod_rules: fixture.automodRules,
    onboarding: fixture.onboarding,
    welcome_screen: fixture.welcome,
    recent_messages: Object.fromEntries(fixture.messages),
    publication_history_complete: Object.fromEntries(
      [...fixture.messages.keys()].map((channelId) => [channelId, true]),
    ),
  };
}

describe('guild_blueprint_apply resumable MCP journey', () => {
  it('treats Discord materializing the default container spoiler as equivalent', () => {
    const fixture = buildConvergedFixture();
    for (const messages of fixture.messages.values()) {
      for (const message of messages) {
        const container = message.components?.[0] as Record<string, unknown>;
        container.spoiler = false;
      }
    }

    const result = reconcileGuildBlueprint(
      BLUEPRINT_ID,
      blueprint,
      snapshotFrom(fixture),
      fixture.bindings,
    );

    expect(result.blockers).toEqual([]);
    expect(result.operations).toEqual([]);
  });

  it('still blocks a publication whose container is changed to a spoiler', () => {
    const fixture = buildConvergedFixture();
    const publication = blueprint.components_v2.publications[0]!;
    const messageId = fixture.bindings.publications[publication.key]!;
    const message = [...fixture.messages.values()]
      .flat()
      .find((candidate) => candidate.id === messageId)!;
    const container = message.components?.[0] as Record<string, unknown>;
    container.spoiler = true;

    const result = reconcileGuildBlueprint(
      BLUEPRINT_ID,
      blueprint,
      snapshotFrom(fixture),
      fixture.bindings,
    );

    expect(result.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'RESOURCE_CONFLICT', resource: `message:${messageId}` }),
      ]),
    );
  });

  it('recovers from a mid-apply 500 and converges without duplicate resources', async () => {
    const fixture = buildConvergedFixture();
    const missingRule = blueprint.automod.rules.at(-1)!;
    const missingPublication = blueprint.components_v2.publications.at(-1)!;
    fixture.automodRules = fixture.automodRules.filter(
      (rule) => rule.id !== fixture.bindings.automod_rules[missingRule.key],
    );
    fixture.bindings.automod_rules = Object.fromEntries(
      Object.entries(fixture.bindings.automod_rules).filter(([key]) => key !== missingRule.key),
    );
    const missingMessageId = fixture.bindings.publications[missingPublication.key]!;
    for (const [channelId, messages] of fixture.messages) {
      fixture.messages.set(
        channelId,
        messages.filter((message) => message.id !== missingMessageId),
      );
    }
    delete fixture.bindings.publications[missingPublication.key];

    const preview = reconcileGuildBlueprint(BLUEPRINT_ID, blueprint, snapshotFrom(fixture));
    expect(preview.blockers).toEqual([]);
    expect(preview.operations.map((operation) => operation.resource)).toEqual([
      'automod_rule',
      'publication',
    ]);
    const planPayload = {
      schema_version: 'guild_blueprint_plan.v1' as const,
      policy_version: 'safe-reconcile.v1' as const,
      target: { guild_id: GUILD_ID, bot_id: BOT_ID },
      blueprint_id: BLUEPRINT_ID,
      blueprint,
      initial_snapshot_id: preview.snapshot_id,
      initial_bindings: preview.bindings,
      initial_operations: preview.operations,
      policy: {
        deletions: false as const,
        ambiguous_matches: 'block' as const,
        unbound_drift: 'block' as const,
        auto_grant_bot_permissions: false as const,
        managed_roles: 'immutable' as const,
        publication_idempotency: 'marker_and_discord_nonce' as const,
      },
    };
    const encoded = encodeBlueprintPlan(planPayload, SIGNING_TOKEN);

    let failPublicationOnce = true;
    let automodCreates = 0;
    let publicationCreates = 0;
    let roleCreates = 0;
    let roleUpdates = 0;
    let channelCreates = 0;
    let stateDirectory: string | undefined;
    let firstDiscordMutationSawDurableCheckpoint = false;
    mockServer.use(
      http.get(`${API}/users/@me`, () =>
        HttpResponse.json({ id: BOT_ID, username: 'DevBot', bot: true }),
      ),
      http.get(`${API}/guilds/:guildId/members/:botId`, () =>
        HttpResponse.json({ user: { id: BOT_ID }, roles: [BOT_ROLE_ID] }),
      ),
      http.get(`${API}/guilds/:guildId/roles`, () => HttpResponse.json(fixture.roles)),
      http.get(`${API}/guilds/:guildId/channels`, () =>
        HttpResponse.json([...fixture.categories, ...fixture.channels]),
      ),
      http.get(`${API}/guilds/:guildId/auto-moderation/rules`, () =>
        HttpResponse.json(fixture.automodRules),
      ),
      http.get(`${API}/guilds/:guildId/onboarding`, () => HttpResponse.json(fixture.onboarding)),
      http.get(`${API}/guilds/:guildId/welcome-screen`, () => HttpResponse.json(fixture.welcome)),
      http.get(`${API}/guilds/:guildId`, () => HttpResponse.json(fixture.guild)),
      http.get(`${API}/channels/:channelId/messages/:messageId`, ({ params }) => {
        const message = (fixture.messages.get(String(params.channelId)) ?? []).find(
          (item) => item.id === params.messageId,
        );
        return message === undefined
          ? HttpResponse.json({ message: 'Unknown Message' }, { status: 404 })
          : HttpResponse.json(message);
      }),
      http.get(`${API}/channels/:channelId/messages`, ({ params }) =>
        HttpResponse.json(fixture.messages.get(String(params.channelId)) ?? []),
      ),
      http.post(`${API}/guilds/:guildId/auto-moderation/rules`, async ({ request }) => {
        automodCreates += 1;
        const checkpointText = await readFile(
          join(stateDirectory!, encoded.plan_id.slice('sha256:'.length), 'checkpoint-v0.json'),
          'utf8',
        );
        const checkpointEnvelope = JSON.parse(checkpointText) as {
          checkpoint?: { status?: string };
        };
        firstDiscordMutationSawDurableCheckpoint =
          checkpointEnvelope.checkpoint?.status === 'applying';
        const body = (await request.json()) as Omit<
          TargetAutoModRule,
          'id' | 'guild_id' | 'creator_id'
        >;
        const created = {
          id: snowflake(999),
          guild_id: GUILD_ID,
          creator_id: BOT_ID,
          ...body,
        } satisfies TargetAutoModRule;
        fixture.automodRules.push(created);
        return HttpResponse.json(created);
      }),
      http.post(`${API}/channels/:channelId/messages`, async ({ params, request }) => {
        if (failPublicationOnce) {
          failPublicationOnce = false;
          return HttpResponse.json({ message: 'synthetic upstream failure' }, { status: 500 });
        }
        publicationCreates += 1;
        const body = (await request.json()) as Record<string, unknown>;
        const channelId = String(params.channelId);
        const created: TargetMessage = {
          id: snowflake(1_000 + publicationCreates),
          channel_id: channelId,
          guild_id: GUILD_ID,
          author: { id: BOT_ID },
          flags: body.flags as number,
          nonce: body.nonce as string,
          mention_everyone: false,
          mentions: [],
          mention_roles: [],
          components: body.components as unknown[],
        };
        fixture.messages.set(channelId, [created, ...(fixture.messages.get(channelId) ?? [])]);
        return HttpResponse.json(created);
      }),
      http.post(`${API}/guilds/:guildId/roles`, () => {
        roleCreates += 1;
        return HttpResponse.json({ message: 'unexpected role create' }, { status: 500 });
      }),
      http.patch(`${API}/guilds/:guildId/roles/:roleId`, async ({ params, request }) => {
        roleUpdates += 1;
        const role = fixture.roles.find((item) => item.id === String(params.roleId));
        if (role === undefined) {
          return HttpResponse.json({ message: 'unknown role' }, { status: 404 });
        }
        Object.assign(role, (await request.json()) as Partial<TargetRole>);
        return HttpResponse.json(role);
      }),
      http.post(`${API}/guilds/:guildId/channels`, () => {
        channelCreates += 1;
        return HttpResponse.json({ message: 'unexpected channel create' }, { status: 500 });
      }),
    );

    stateDirectory = await mkdtemp(join(tmpdir(), 'discord-mcp-apply-integration-'));
    const originalDryRun = process.env.MCP_DRY_RUN;
    process.env.MCP_DRY_RUN = 'false';
    let client: Client | undefined;
    try {
      const config = loadConfig({
        DISCORD_TOKEN: SIGNING_TOKEN,
        DISCORD_EXPECTED_BOT_ID: BOT_ID,
        ALLOWED_GUILDS: GUILD_ID,
        MCP_BLUEPRINT_STATE_DIR: stateDirectory,
        LOG_LEVEL: 'fatal',
        MCP_AUDIT_ENABLED: 'false',
      });
      const rest = new REST({ version: '10', retries: 0, makeRequest: fetch }).setToken(
        SIGNING_TOKEN,
      );
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const built = await buildServer({ rest, logger: createLogger(config), config });
      client = new Client({ name: 'blueprint-apply-test', version: '0.0.0' }, { capabilities: {} });
      await Promise.all([built.server.connect(serverTransport), client.connect(clientTransport)]);

      const args = {
        guild_id: GUILD_ID,
        expected_bot_id: BOT_ID,
        plan_token: encoded.plan_token,
        approval_id: encoded.approval_id,
        operation_budget: 50,
        __confirm: true,
      };
      const planRef = await saveBlueprintPlanReference({
        stateDirectory,
        planId: encoded.plan_id,
        payload: planPayload,
        signingSecret: SIGNING_TOKEN,
      });
      const refArgs = {
        ...args,
        plan_ref: planRef,
        plan_token: undefined,
      };
      const wrongTarget = await client.callTool({
        name: 'guild_blueprint_apply',
        arguments: { ...args, expected_bot_id: '100000000000000099' },
      });
      expect(wrongTarget.structuredContent).toMatchObject({
        status: 'blocked',
        blockers: [expect.objectContaining({ code: 'PLAN_TARGET_MISMATCH' })],
      });
      expect(automodCreates + publicationCreates + roleCreates + channelCreates).toBe(0);

      const stale = encodeBlueprintPlan(
        { ...planPayload, initial_snapshot_id: `sha256:${'9'.repeat(64)}` },
        SIGNING_TOKEN,
      );
      const staleResult = await client.callTool({
        name: 'guild_blueprint_apply',
        arguments: {
          ...args,
          plan_token: stale.plan_token,
          approval_id: stale.approval_id,
        },
      });
      expect(staleResult.structuredContent).toMatchObject({
        status: 'stale',
        blockers: [expect.objectContaining({ code: 'PLAN_SNAPSHOT_STALE' })],
      });
      expect(automodCreates + publicationCreates + roleCreates + channelCreates).toBe(0);

      const first = await client.callTool({ name: 'guild_blueprint_apply', arguments: refArgs });
      expect(first.isError).toBe(false);
      expect(first.structuredContent).toMatchObject({
        status: 'partial',
        error: { code: 'DISCORD_API_ERROR', retriable: true, status: 500 },
        evidence: { checkpoint_persisted: true },
      });
      expect(automodCreates).toBe(1);
      expect(publicationCreates).toBe(0);
      expect(firstDiscordMutationSawDurableCheckpoint).toBe(true);

      const second = await client.callTool({ name: 'guild_blueprint_apply', arguments: refArgs });
      expect(second.isError).toBe(false);
      expect(second.structuredContent).toMatchObject({
        status: 'complete',
        progress: { remaining: 0 },
        evidence: { readback: 'match', checkpoint_persisted: true },
        next_action: 'done',
      });
      expect(automodCreates).toBe(1);
      expect(publicationCreates).toBe(1);
      expect(roleCreates).toBe(0);
      expect(channelCreates).toBe(0);

      const noOpPreview = reconcileGuildBlueprint(BLUEPRINT_ID, blueprint, snapshotFrom(fixture));
      expect(noOpPreview.operations).toEqual([]);
      expect(noOpPreview.blockers).toEqual([]);
      const noOpPlan = encodeBlueprintPlan(
        {
          ...planPayload,
          initial_snapshot_id: noOpPreview.snapshot_id,
          initial_bindings: noOpPreview.bindings,
          initial_operations: noOpPreview.operations,
        },
        SIGNING_TOKEN,
      );
      const noOpArgs = {
        ...args,
        plan_token: noOpPlan.plan_token,
        approval_id: noOpPlan.approval_id,
      };
      const evidencePath = join(
        stateDirectory,
        noOpPlan.plan_id.slice('sha256:'.length),
        'activity-evidence.json',
      );
      await mkdir(evidencePath, { recursive: true });

      const evidenceIo = await client.callTool({
        name: 'guild_blueprint_apply',
        arguments: noOpArgs,
      });
      expect(evidenceIo.structuredContent).toMatchObject({
        status: 'partial',
        error: { code: 'EVIDENCE_IO', retriable: true },
        evidence: { activity: null, checkpoint_persisted: true },
        next_action: 'resume',
      });
      expect(automodCreates).toBe(1);
      expect(publicationCreates).toBe(1);

      await rm(evidencePath, { recursive: true, force: true });
      const recoveredNoOp = await client.callTool({
        name: 'guild_blueprint_apply',
        arguments: noOpArgs,
      });
      expect(recoveredNoOp.structuredContent).toMatchObject({
        status: 'already_current',
        progress: { remaining: 0 },
        evidence: {
          readback: 'match',
          activity: {
            schema_version: 'guild_blueprint_activity_evidence.v1',
          },
        },
        next_action: 'done',
      });
      expect(automodCreates).toBe(1);
      expect(publicationCreates).toBe(1);

      const third = await client.callTool({ name: 'guild_blueprint_apply', arguments: args });
      expect(third.structuredContent).toMatchObject({ status: 'already_current' });
      expect(automodCreates).toBe(1);
      expect(publicationCreates).toBe(1);
      const publicationMessages = [...fixture.messages.values()]
        .flat()
        .filter((message) =>
          JSON.stringify(message.components).includes(`publication ${missingPublication.key}`),
        );
      expect(publicationMessages).toHaveLength(1);

      const driftedRole = fixture.roles.find(
        (role) => role.id === fixture.bindings.roles[blueprint.roles[0]!.key],
      )!;
      driftedRole.name = 'Externally renamed after completion';
      const replayAfterExternalDrift = await client.callTool({
        name: 'guild_blueprint_apply',
        arguments: args,
      });
      expect(replayAfterExternalDrift.structuredContent).toMatchObject({
        status: 'blocked',
        next_action: 'replan',
        blockers: [expect.objectContaining({ code: 'PLAN_ALREADY_CONSUMED' })],
      });
      expect(roleUpdates).toBe(0);
      expect(automodCreates + publicationCreates + roleCreates + channelCreates).toBe(2);
    } finally {
      await client?.close();
      await rm(stateDirectory!, { recursive: true, force: true });
      if (originalDryRun === undefined) delete process.env.MCP_DRY_RUN;
      else process.env.MCP_DRY_RUN = originalDryRun;
    }
  });
});
