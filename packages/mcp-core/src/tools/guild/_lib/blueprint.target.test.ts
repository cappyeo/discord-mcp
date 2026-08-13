import type { REST } from '@discordjs/rest';
import { Routes } from 'discord-api-types/v10';
import { describe, expect, it, vi } from 'vitest';
import { desiredPublicationBody, publicationMarker } from './blueprint.desired.js';
import type { BlueprintBindings } from './blueprint.execution.schema.js';
import { emptyBlueprintBindings } from './blueprint.execution.schema.js';
import { compileGuildBlueprint } from './blueprint.js';
import { reconcileGuildBlueprint } from './blueprint.reconcile.js';
import type { GuildBlueprint } from './blueprint.schema.js';
import { channelType, readBlueprintTargetSnapshot } from './blueprint.target.js';

const guildId = '100000000000000001';
const botId = '100000000000000002';
const blueprintId = `sha256:${'a'.repeat(64)}`;

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

function publicationFixture() {
  const publication = blueprint.components_v2.publications[0]!;
  const channel = blueprint.channels.find((item) => item.key === publication.channel_key)!;
  const channelId = '200000000000000001';
  const messageId = '300000000000000001';
  const channelBindings = Object.fromEntries(
    blueprint.channels.map((item, index) => [
      item.key,
      `200000000000000${String(index + 1).padStart(3, '0')}`,
    ]),
  );
  channelBindings[channel.key] = channelId;
  const bindings: BlueprintBindings = {
    ...emptyBlueprintBindings(),
    channels: channelBindings,
    publications: { [publication.key]: messageId },
  };
  const desired = desiredPublicationBody(publication, blueprintId, guildId, botId, bindings)!;
  return { publication, channelId, messageId, bindings, desired };
}

function targetChannel(blueprintChannel: GuildBlueprint['channels'][number], id: string) {
  return {
    id,
    guild_id: guildId,
    name: blueprintChannel.name,
    type: channelType(blueprintChannel.type),
    position: blueprintChannel.position,
    parent_id: null,
    topic: null,
    nsfw: false,
    rate_limit_per_user: 0,
    permission_overwrites: [],
    available_tags: [],
  };
}

function fakeRest(
  channelId: string,
  recentMessages: unknown[],
  exactMessage: unknown | Error | undefined,
  messagePages: readonly (readonly unknown[])[] = [recentMessages, []],
  automodRules: readonly unknown[] = [],
  ...channelGuildIdArgument: [string | undefined]
): REST {
  let messagePage = 0;
  const channelGuildId = channelGuildIdArgument.length === 0 ? guildId : channelGuildIdArgument[0];
  return {
    get: async (route: string) => {
      if (route === Routes.guild(guildId)) {
        return {
          id: guildId,
          name: 'Test',
          owner_id: '100000000000000003',
          description: null,
          preferred_locale: 'en-US',
          features: [],
          verification_level: 0,
          default_message_notifications: 0,
          explicit_content_filter: 0,
          rules_channel_id: null,
          public_updates_channel_id: null,
          safety_alerts_channel_id: null,
        };
      }
      if (route === Routes.guildMember(guildId, botId)) return { user: { id: botId }, roles: [] };
      if (route === Routes.guildRoles(guildId)) return [];
      if (route === Routes.guildChannels(guildId)) {
        const channel = targetChannel(
          blueprint.channels.find(
            (item) => item.key === blueprint.components_v2.publications[0]!.channel_key,
          )!,
          channelId,
        );
        if (channelGuildId === undefined) {
          const { guild_id: _guildId, ...withoutGuildId } = channel;
          return [withoutGuildId];
        }
        return [{ ...channel, guild_id: channelGuildId }];
      }
      if (route === Routes.guildAutoModerationRules(guildId)) return automodRules;
      if (route === Routes.channelMessages(channelId)) {
        const page = messagePages[Math.min(messagePage, messagePages.length - 1)] ?? [];
        messagePage += 1;
        return page;
      }
      if (route === Routes.channelMessage(channelId, '300000000000000001')) {
        if (exactMessage instanceof Error) throw exactMessage;
        return exactMessage;
      }
      throw new Error(`Unexpected route ${route}`);
    },
  } as unknown as REST;
}

describe('blueprint publication target readback', () => {
  it('forwards one caller signal to every target read request', async () => {
    const controller = new AbortController();
    const base = fakeRest('200000000000000001', [], undefined);
    const baseGet = base.get as unknown as (
      route: string,
      options?: { signal?: AbortSignal },
    ) => Promise<unknown>;
    const get = vi.fn((route: string, options?: { signal?: AbortSignal }) =>
      baseGet.call(base, route, options),
    );

    await readBlueprintTargetSnapshot(
      { get } as unknown as REST,
      guildId,
      botId,
      blueprint,
      undefined,
      controller.signal,
    );

    expect(get).toHaveBeenCalled();
    expect(get.mock.calls.every(([, options]) => options?.signal === controller.signal)).toBe(true);
  });

  it('keeps a publication nonce stable for one channel and changes it for a new channel lifecycle', () => {
    const { publication, bindings, desired } = publicationFixture();
    const repeated = desiredPublicationBody(publication, blueprintId, guildId, botId, bindings)!;
    const replacementBindings = {
      ...bindings,
      channels: {
        ...bindings.channels,
        [publication.channel_key]: '200000000000000099',
      },
    };
    const replacement = desiredPublicationBody(
      publication,
      blueprintId,
      guildId,
      botId,
      replacementBindings,
    )!;

    expect(repeated.body.nonce).toBe(desired.body.nonce);
    expect(replacement.body.nonce).not.toBe(desired.body.nonce);
  });

  it.each([
    ['missing', undefined],
    ['mismatched', '100000000000000099'],
  ])('rejects a %s guild channel identity before publication reconciliation', async (_, channelGuildId) => {
    await expect(
      readBlueprintTargetSnapshot(
        fakeRest('200000000000000001', [], undefined, [[], []], [], channelGuildId),
        guildId,
        botId,
        blueprint,
      ),
    ).rejects.toMatchObject({ code: 'TARGET_GUILD_MISMATCH' });
  });

  it('rejects a publication message that explicitly identifies another guild', async () => {
    const { channelId, bindings } = publicationFixture();
    await expect(
      readBlueprintTargetSnapshot(
        fakeRest(channelId, [], {
          id: bindings.publications[blueprint.components_v2.publications[0]!.key],
          channel_id: channelId,
          guild_id: '100000000000000099',
        }),
        guildId,
        botId,
        blueprint,
        bindings,
      ),
    ).rejects.toMatchObject({ code: 'TARGET_GUILD_MISMATCH' });
  });

  it('rejects an AutoMod rule whose creator_id is not a Discord snowflake', async () => {
    await expect(
      readBlueprintTargetSnapshot(
        fakeRest(
          '200000000000000001',
          [],
          undefined,
          [[], []],
          [
            {
              id: '400000000000000001',
              guild_id: guildId,
              creator_id: 'not-a-snowflake',
            },
          ],
        ),
        guildId,
        botId,
        blueprint,
      ),
    ).rejects.toMatchObject({ code: 'TARGET_INVALID_SNOWFLAKE' });
  });

  it('fetches a checkpoint-bound message by exact id when it is outside recent history', async () => {
    const { publication, channelId, messageId, bindings, desired } = publicationFixture();
    const recent = Array.from({ length: 100 }, (_, index) => ({
      id: `399999999999999${String(index).padStart(3, '0')}`,
      channel_id: channelId,
      guild_id: guildId,
      author: { id: botId },
      components: [],
    }));
    const exact = {
      id: messageId,
      channel_id: channelId,
      guild_id: guildId,
      author: { id: botId },
      flags: desired.body.flags,
      nonce: desired.body.nonce,
      mention_everyone: false,
      mentions: [],
      mention_roles: [],
      components: desired.body.components,
    };
    const snapshot = await readBlueprintTargetSnapshot(
      fakeRest(channelId, recent, exact),
      guildId,
      botId,
      blueprint,
      bindings,
    );

    expect(snapshot.recent_messages[channelId]).toHaveLength(101);
    const result = reconcileGuildBlueprint(blueprintId, blueprint, snapshot, bindings);
    expect(result.bindings.publications[publication.key]).toBe(messageId);
    expect(
      result.operations.some(
        (operation) => operation.key === publication.key && operation.action === 'send',
      ),
    ).toBe(false);
  });

  it("excludes Discord's immutable default AutoMod rule but retains other rules", async () => {
    const snapshot = await readBlueprintTargetSnapshot(
      fakeRest(
        '200000000000000001',
        [],
        undefined,
        [[], []],
        [
          {
            id: '1030554520465440818',
            guild_id: guildId,
            creator_id: '1008776202191634432',
            trigger_type: 5,
          },
          {
            id: '1030554520465440819',
            guild_id: guildId,
            creator_id: '1008776202191634432',
            trigger_type: 5,
          },
        ],
      ),
      guildId,
      botId,
      blueprint,
    );

    expect(snapshot.automod_rules.map((rule) => rule.id)).toEqual(['1030554520465440819']);
  });

  it('treats an exact-message 404 as a safe replacement opportunity', async () => {
    const { publication, channelId, bindings } = publicationFixture();
    const snapshot = await readBlueprintTargetSnapshot(
      fakeRest(channelId, [], Object.assign(new Error('not found'), { status: 404 })),
      guildId,
      botId,
      blueprint,
      bindings,
    );
    const result = reconcileGuildBlueprint(blueprintId, blueprint, snapshot, bindings);

    expect(result.blockers).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'RESOURCE_CONFLICT' })]),
    );
    expect(result.operations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: 'send', resource: 'publication', key: publication.key }),
      ]),
    );
  });

  it('blocks changed content that retains its marker without scheduling a duplicate', async () => {
    const { publication, channelId, bindings, desired } = publicationFixture();
    const marker = publicationMarker(blueprintId, publication.key);
    const altered = {
      id: bindings.publications[publication.key],
      channel_id: channelId,
      guild_id: guildId,
      author: { id: botId },
      flags: desired.body.flags,
      nonce: desired.body.nonce,
      mention_everyone: false,
      mentions: [],
      mention_roles: [],
      components: [{ type: 10, content: `externally edited\n${marker}` }],
    };
    const snapshot = await readBlueprintTargetSnapshot(
      fakeRest(channelId, [], altered),
      guildId,
      botId,
      blueprint,
      bindings,
    );
    const result = reconcileGuildBlueprint(blueprintId, blueprint, snapshot, bindings);

    expect(result.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'RESOURCE_CONFLICT',
          resource: `message:${bindings.publications[publication.key]}`,
        }),
      ]),
    );
    expect(
      result.operations.some(
        (operation) => operation.key === publication.key && operation.action === 'send',
      ),
    ).toBe(false);
  });

  it('paginates past the newest 100 messages to adopt an exact managed publication', async () => {
    const { publication, channelId, bindings, desired } = publicationFixture();
    const unbound = { ...bindings, publications: {} };
    const newest = Array.from({ length: 100 }, (_, index) => ({
      id: `399999999999999${String(index).padStart(3, '0')}`,
      channel_id: channelId,
      guild_id: guildId,
      author: { id: botId },
      components: [],
    }));
    const managed = {
      id: '300000000000000001',
      channel_id: channelId,
      guild_id: guildId,
      author: { id: botId },
      flags: desired.body.flags,
      nonce: desired.body.nonce,
      mention_everyone: false,
      mentions: [],
      mention_roles: [],
      components: desired.body.components,
    };
    const snapshot = await readBlueprintTargetSnapshot(
      fakeRest(channelId, newest, undefined, [newest, [managed]]),
      guildId,
      botId,
      blueprint,
      unbound,
    );
    const result = reconcileGuildBlueprint(blueprintId, blueprint, snapshot, unbound);

    expect(snapshot.recent_messages[channelId]).toHaveLength(101);
    expect(snapshot.publication_history_complete[channelId]).toBe(true);
    expect(result.blockers).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ resource: `message:${managed.id}` })]),
    );
    expect(result.bindings.publications[publication.key]).toBe(managed.id);
    expect(result.operations).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: publication.key,
          resource: 'publication',
          action: 'send',
        }),
      ]),
    );
  });

  it('fails closed at the bounded history cap without scheduling a duplicate publication', async () => {
    const { publication, channelId, bindings } = publicationFixture();
    const unbound = { ...bindings, publications: {} };
    const pages = Array.from({ length: 10 }, (_, page) =>
      Array.from({ length: 100 }, (_, index) => ({
        id: `${400000000000000000n - BigInt(page * 100 + index)}`,
        channel_id: channelId,
        guild_id: guildId,
        author: { id: botId },
        components: [],
      })),
    );
    const snapshot = await readBlueprintTargetSnapshot(
      fakeRest(channelId, [], undefined, pages),
      guildId,
      botId,
      blueprint,
      unbound,
    );
    const result = reconcileGuildBlueprint(blueprintId, blueprint, snapshot, unbound);

    expect(snapshot.recent_messages[channelId]).toHaveLength(1_000);
    expect(snapshot.publication_history_complete[channelId]).toBe(false);
    expect(result.blockers).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'PUBLICATION_HISTORY_INCOMPLETE' })]),
    );
    expect(result.operations).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: publication.key, resource: 'publication', action: 'send' }),
      ]),
    );
  });
});
