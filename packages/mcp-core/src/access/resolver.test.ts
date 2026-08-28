import type { REST } from '@discordjs/rest';
import { PermissionFlagsBits, Routes } from 'discord-api-types/v10';
import { describe, expect, it, vi } from 'vitest';
import {
  CHANNEL_WRITE_ACCESS,
  GUILD_READ_ACCESS,
  getToolAccessRequirement,
  resolveToolAccessRequirement,
} from './requirements.js';
import { createRuntimeAccessResolver } from './resolver.js';
import { evaluateRuntimeAccess, type RuntimeAccessRequest } from './runtime.js';

const BOT_ID = '987654321098765432';
const GUILD_ID = '111122223333444455';
const CHANNEL_ID = '222233334444555566';
const ROLE_ID = '333344445555666677';
const TARGET_ROLE_ID = '444455556666777788';
const SKU_ID = '555566667777888899';
const FOREIGN_GUILD_ID = '666677778888999900';
const FOREIGN_CHANNEL_ID = '777788889999000011';

function restFor(routes: Record<string, unknown>): { rest: REST; get: ReturnType<typeof vi.fn> } {
  const get = vi.fn(async (path: string) => {
    if (!Object.hasOwn(routes, path)) throw new Error(`unexpected GET ${path}`);
    const value = routes[path];
    return typeof value === 'function' ? (value as () => unknown)() : value;
  });
  return { rest: { get } as unknown as REST, get };
}

function identityRoutes(): Record<string, unknown> {
  return {
    [Routes.user('@me')]: { id: BOT_ID, bot: true },
    [Routes.currentApplication()]: { id: BOT_ID, bot: { id: BOT_ID } },
  };
}

function guildRoutes(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...identityRoutes(),
    [Routes.guild(GUILD_ID)]: { id: GUILD_ID, owner_id: '999988887777666699' },
    [Routes.guildMember(GUILD_ID, BOT_ID)]: { user: { id: BOT_ID }, roles: [ROLE_ID] },
    [Routes.guildRoles(GUILD_ID)]: [
      {
        id: GUILD_ID,
        name: '@everyone',
        position: 0,
        permissions: String(PermissionFlagsBits.ViewChannel),
        managed: false,
      },
      {
        id: ROLE_ID,
        name: 'Bot',
        position: 5,
        permissions: String(PermissionFlagsBits.SendMessages),
        managed: false,
      },
    ],
    ...overrides,
  };
}

describe('createRuntimeAccessResolver', () => {
  it('honors the request bot lock even when the resolver has no configured lock', async () => {
    const { rest } = restFor(identityRoutes());
    const resolver = createRuntimeAccessResolver({ rest });
    const evidence = await resolver({
      toolName: 'users_get_current',
      args: {},
      requirement: getToolAccessRequirement('users_get_current').requirement!,
      expectedBotId: '999000999000999000',
    });
    expect(evidence).toMatchObject({ status: 'unknown', identityVerified: true, botId: BOT_ID });
  });

  it('proves a locked bot application without exposing raw application data', async () => {
    const { rest, get } = restFor(identityRoutes());
    const resolver = createRuntimeAccessResolver({ rest, expectedBotId: BOT_ID });
    const request: RuntimeAccessRequest = {
      toolName: 'app_emojis_list',
      args: {},
      requirement: getToolAccessRequirement('app_emojis_list').requirement!,
      expectedBotId: BOT_ID,
    };

    const evidence = await resolver(request);
    expect(evidence).toMatchObject({
      status: 'complete',
      identityVerified: true,
      botId: BOT_ID,
      target: BOT_ID,
    });
    expect(evidence).not.toHaveProperty('application');
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('proves a user-scoped recipient without pretending to prove consent', async () => {
    const { rest, get } = restFor(identityRoutes());
    const resolver = createRuntimeAccessResolver({ rest, expectedBotId: BOT_ID });
    const requirement = getToolAccessRequirement('users_create_dm').requirement!;
    const evidence = await resolver({
      toolName: 'users_create_dm',
      args: { recipient_id: '999000999000999000' },
      requirement,
      expectedBotId: BOT_ID,
    });
    expect(evidence).toMatchObject({
      status: 'complete',
      identityVerified: true,
      botId: BOT_ID,
      target: 'user/999000999000999000',
    });
    expect(get).toHaveBeenCalledTimes(1);
    const decision = evaluateRuntimeAccess(
      {
        toolName: 'users_create_dm',
        args: { recipient_id: '999000999000999000' },
        requirement,
        expectedBotId: BOT_ID,
      },
      evidence,
    );
    expect(decision.status).toBe('allowed');
  });

  it('keeps malformed user recipients unresolved after identity verification', async () => {
    const { rest } = restFor(identityRoutes());
    const resolver = createRuntimeAccessResolver({ rest, expectedBotId: BOT_ID });
    const evidence = await resolver({
      toolName: 'users_create_dm',
      args: { recipient_id: 'not-a-snowflake' },
      requirement: getToolAccessRequirement('users_create_dm').requirement!,
      expectedBotId: BOT_ID,
    });
    expect(evidence).toMatchObject({ status: 'unknown', identityVerified: true, botId: BOT_ID });
  });

  it('rejects an explicit application target that is not the authenticated bot', async () => {
    const { rest } = restFor(identityRoutes());
    const resolver = createRuntimeAccessResolver({ rest, expectedBotId: BOT_ID });
    const evidence = await resolver({
      toolName: 'app_emojis_list',
      args: { application_id: '999000999000999000' },
      requirement: getToolAccessRequirement('app_emojis_list').requirement!,
      expectedBotId: BOT_ID,
    });
    expect(evidence).toMatchObject({ status: 'unknown', identityVerified: true });
  });

  it('binds SKU-based subscription reads to the authenticated application', async () => {
    const { rest } = restFor({
      ...identityRoutes(),
      [`/skus/${SKU_ID}`]: { id: SKU_ID, application_id: BOT_ID },
    });
    const resolver = createRuntimeAccessResolver({ rest, expectedBotId: BOT_ID });
    const requirement = getToolAccessRequirement('subscriptions_list').requirement!;
    await expect(
      resolver({
        toolName: 'subscriptions_list',
        args: { sku_id: SKU_ID },
        requirement,
        expectedBotId: BOT_ID,
      }),
    ).resolves.toMatchObject({ status: 'complete', target: BOT_ID });

    const wrong = restFor({
      ...identityRoutes(),
      [`/skus/${SKU_ID}`]: { id: SKU_ID, application_id: '999000999000999000' },
    });
    await expect(
      createRuntimeAccessResolver({ rest: wrong.rest, expectedBotId: BOT_ID })({
        toolName: 'subscriptions_get',
        args: { sku_id: SKU_ID, subscription_id: '666677778888999900' },
        requirement: getToolAccessRequirement('subscriptions_get').requirement!,
        expectedBotId: BOT_ID,
      }),
    ).resolves.toMatchObject({ status: 'unknown' });
  });

  it('evaluates a channel snapshot and caches the read-only evidence', async () => {
    const { rest, get } = restFor(
      guildRoutes({
        [Routes.channel(CHANNEL_ID)]: {
          id: CHANNEL_ID,
          guild_id: GUILD_ID,
          type: 0,
          permission_overwrites: [],
        },
      }),
    );
    const resolver = createRuntimeAccessResolver({ rest, expectedBotId: BOT_ID });
    const request: RuntimeAccessRequest = {
      toolName: 'components_v2_send',
      args: { channel_id: CHANNEL_ID },
      requirement: CHANNEL_WRITE_ACCESS,
      expectedBotId: BOT_ID,
    };
    const first = await resolver(request);
    const second = await resolver(request);
    expect(first.status).toBe('complete');
    expect(second.status).toBe('complete');
    expect(get).toHaveBeenCalledTimes(5); // identity + channel + guild/member/roles
  });

  it('keeps message-content data unresolved unless runtime intent evidence is supplied', async () => {
    const { rest } = restFor(
      guildRoutes({
        [Routes.channel(CHANNEL_ID)]: {
          id: CHANNEL_ID,
          guild_id: GUILD_ID,
          type: 0,
          permission_overwrites: [],
        },
      }),
    );
    const requirement = getToolAccessRequirement('messages_read').requirement!;
    const missingResolver = createRuntimeAccessResolver({
      rest,
      expectedBotId: BOT_ID,
      runtimeIntents: { MESSAGE_CONTENT: 'missing' },
    });
    const evidence = await missingResolver({
      toolName: 'messages_read',
      args: { channel_id: CHANNEL_ID },
      requirement,
      expectedBotId: BOT_ID,
    });
    expect(evidence.intents).toEqual({ MESSAGE_CONTENT: 'missing' });
    expect(
      evaluateRuntimeAccess(
        {
          toolName: 'messages_read',
          args: { channel_id: CHANNEL_ID },
          requirement,
          expectedBotId: BOT_ID,
        },
        evidence,
      ),
    ).toMatchObject({ status: 'denied', missingIntents: ['MESSAGE_CONTENT'] });
  });

  it('rejects a guild request that pairs its guild with a foreign channel', async () => {
    const { rest, get } = restFor(
      guildRoutes({
        [Routes.channel(FOREIGN_CHANNEL_ID)]: {
          id: FOREIGN_CHANNEL_ID,
          guild_id: FOREIGN_GUILD_ID,
          type: 0,
          permission_overwrites: [],
        },
      }),
    );
    const resolver = createRuntimeAccessResolver({ rest, expectedBotId: BOT_ID });
    const evidence = await resolver({
      toolName: 'guild_modify',
      args: { guild_id: GUILD_ID, system_channel_id: FOREIGN_CHANNEL_ID },
      requirement: getToolAccessRequirement('guild_modify').requirement!,
      expectedBotId: BOT_ID,
    });
    expect(evidence).toMatchObject({ status: 'unknown', identityVerified: true });
    expect(get).toHaveBeenCalledTimes(2); // identity + foreign channel; do not read the guild
  });

  it('does not admit a cross-guild channel operation without evidence for every guild', async () => {
    const { rest, get } = restFor(
      guildRoutes({
        [Routes.channel(CHANNEL_ID)]: {
          id: CHANNEL_ID,
          guild_id: GUILD_ID,
          type: 0,
          permission_overwrites: [],
        },
        [Routes.channel(FOREIGN_CHANNEL_ID)]: {
          id: FOREIGN_CHANNEL_ID,
          guild_id: FOREIGN_GUILD_ID,
          type: 0,
          permission_overwrites: [],
        },
      }),
    );
    const resolver = createRuntimeAccessResolver({ rest, expectedBotId: BOT_ID });
    const evidence = await resolver({
      toolName: 'channels_follow_announcement',
      args: { channel_id: CHANNEL_ID, webhook_channel_id: FOREIGN_CHANNEL_ID },
      requirement: getToolAccessRequirement('channels_follow_announcement').requirement!,
      expectedBotId: BOT_ID,
    });
    expect(evidence.status).toBe('unknown');
    expect(get).toHaveBeenCalledWith(Routes.guild(FOREIGN_GUILD_ID), undefined);
  });

  it('evaluates the declared permission target for an intentional cross-guild follow', async () => {
    const foreignRoleId = '888899990000111122';
    const routes = {
      ...identityRoutes(),
      [Routes.channel(CHANNEL_ID)]: {
        id: CHANNEL_ID,
        guild_id: GUILD_ID,
        type: 5,
        permission_overwrites: [],
      },
      [Routes.channel(FOREIGN_CHANNEL_ID)]: {
        id: FOREIGN_CHANNEL_ID,
        guild_id: FOREIGN_GUILD_ID,
        type: 0,
        permission_overwrites: [],
      },
      [Routes.guild(GUILD_ID)]: { id: GUILD_ID, owner_id: '999988887777666699' },
      [Routes.guildMember(GUILD_ID, BOT_ID)]: { user: { id: BOT_ID }, roles: [ROLE_ID] },
      [Routes.guildRoles(GUILD_ID)]: [
        { id: GUILD_ID, name: '@everyone', position: 0, permissions: '0', managed: false },
        { id: ROLE_ID, name: 'Source bot', position: 5, permissions: '0', managed: false },
      ],
      [Routes.guild(FOREIGN_GUILD_ID)]: {
        id: FOREIGN_GUILD_ID,
        owner_id: '999988887777666699',
      },
      [Routes.guildMember(FOREIGN_GUILD_ID, BOT_ID)]: {
        user: { id: BOT_ID },
        roles: [foreignRoleId],
      },
      [Routes.guildRoles(FOREIGN_GUILD_ID)]: [
        { id: FOREIGN_GUILD_ID, name: '@everyone', position: 0, permissions: '0', managed: false },
        {
          id: foreignRoleId,
          name: 'Target bot',
          position: 5,
          permissions: String(PermissionFlagsBits.ViewChannel | PermissionFlagsBits.ManageWebhooks),
          managed: false,
        },
      ],
    };
    const { rest } = restFor(routes);
    const resolver = createRuntimeAccessResolver({ rest, expectedBotId: BOT_ID });
    const request = {
      toolName: 'channels_follow_announcement',
      args: { channel_id: CHANNEL_ID, webhook_channel_id: FOREIGN_CHANNEL_ID },
      requirement: getToolAccessRequirement('channels_follow_announcement').requirement!,
      expectedBotId: BOT_ID,
    } satisfies RuntimeAccessRequest;
    const evidence = await resolver(request);
    expect(evidence.status).toBe('complete');
    expect(evidence.target).toContain(`${GUILD_ID}/${CHANNEL_ID}`);
    expect(evidence.target).toContain(`${FOREIGN_GUILD_ID}/${FOREIGN_CHANNEL_ID}`);
    expect(evaluateRuntimeAccess(request, evidence).status).toBe('allowed');
  });

  it('fails closed when the announcement source cannot be read', async () => {
    const { rest } = restFor({
      ...identityRoutes(),
      [Routes.channel(CHANNEL_ID)]: () => {
        throw new Error('source channel forbidden');
      },
      [Routes.channel(FOREIGN_CHANNEL_ID)]: {
        id: FOREIGN_CHANNEL_ID,
        guild_id: FOREIGN_GUILD_ID,
        type: 0,
        permission_overwrites: [],
      },
    });
    const evidence = await createRuntimeAccessResolver({ rest, expectedBotId: BOT_ID })({
      toolName: 'channels_follow_announcement',
      args: { channel_id: CHANNEL_ID, webhook_channel_id: FOREIGN_CHANNEL_ID },
      requirement: getToolAccessRequirement('channels_follow_announcement').requirement!,
      expectedBotId: BOT_ID,
    });
    expect(evidence.status).toBe('unknown');
  });

  it('requires explicit guild and channel targets to describe the same guild', async () => {
    const { rest } = restFor({
      ...guildRoutes(),
      [Routes.channel(FOREIGN_CHANNEL_ID)]: {
        id: FOREIGN_CHANNEL_ID,
        guild_id: FOREIGN_GUILD_ID,
        type: 0,
        permission_overwrites: [],
      },
    });
    const resolver = createRuntimeAccessResolver({ rest, expectedBotId: BOT_ID });
    const evidence = await resolver({
      toolName: 'components_v2_send',
      args: { guild_id: GUILD_ID, channel_id: FOREIGN_CHANNEL_ID },
      requirement: CHANNEL_WRITE_ACCESS,
      expectedBotId: BOT_ID,
    });
    expect(evidence).toMatchObject({ status: 'unknown', identityVerified: true });
  });

  it('propagates caller cancellation while resolving a guild channel hint', async () => {
    let rejectChannel: ((reason?: unknown) => void) | undefined;
    const get = vi.fn((path: string) => {
      if (path === Routes.user('@me')) return Promise.resolve({ id: BOT_ID, bot: true });
      if (path === Routes.channel(CHANNEL_ID)) {
        return new Promise((_resolve, reject) => {
          rejectChannel = reject;
        });
      }
      return Promise.reject(new Error(`unexpected GET ${path}`));
    });
    const resolver = createRuntimeAccessResolver({
      rest: { get } as unknown as REST,
      expectedBotId: BOT_ID,
    });
    const controller = new AbortController();
    const pending = resolver({
      toolName: 'guild_modify',
      args: { guild_id: GUILD_ID, system_channel_id: CHANNEL_ID },
      requirement: getToolAccessRequirement('guild_modify').requirement!,
      expectedBotId: BOT_ID,
      signal: controller.signal,
    });
    controller.abort(new DOMException('aborted', 'AbortError'));
    rejectChannel?.(controller.signal.reason);
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('keeps incomplete channel overwrite evidence unknown', async () => {
    const { rest } = restFor(
      guildRoutes({
        [Routes.channel(CHANNEL_ID)]: {
          id: CHANNEL_ID,
          guild_id: GUILD_ID,
          type: 0,
          // Discord may omit overwrites when the caller cannot inspect them.
        },
      }),
    );
    const resolver = createRuntimeAccessResolver({ rest, expectedBotId: BOT_ID });
    const evidence = await resolver({
      toolName: 'components_v2_send',
      args: { channel_id: CHANNEL_ID },
      requirement: CHANNEL_WRITE_ACCESS,
      expectedBotId: BOT_ID,
    });
    expect(evidence.status).toBe('partial');
    expect(
      evaluateRuntimeAccess(
        {
          toolName: 'components_v2_send',
          args: { channel_id: CHANNEL_ID },
          requirement: CHANNEL_WRITE_ACCESS,
          expectedBotId: BOT_ID,
        },
        evidence,
      ).status,
    ).toBe('unknown');
  });

  it('proves a role target is below the bot and denies a higher target', async () => {
    const routes = guildRoutes({
      [Routes.guildRoles(GUILD_ID)]: [
        {
          id: GUILD_ID,
          name: '@everyone',
          position: 0,
          permissions: String(PermissionFlagsBits.ManageRoles),
          managed: false,
        },
        { id: ROLE_ID, name: 'Bot', position: 5, permissions: '0', managed: false },
        { id: TARGET_ROLE_ID, name: 'Target', position: 2, permissions: '0', managed: false },
      ],
    });
    const { rest } = restFor(routes);
    const resolver = createRuntimeAccessResolver({ rest, expectedBotId: BOT_ID });
    const requirement = getToolAccessRequirement('roles_modify').requirement!;
    const base = {
      toolName: 'roles_modify',
      requirement,
      expectedBotId: BOT_ID,
    } satisfies Omit<RuntimeAccessRequest, 'args'>;
    const allowed = await resolver({
      ...base,
      args: { guild_id: GUILD_ID, role_id: TARGET_ROLE_ID },
    });
    expect(allowed.hierarchy).toBe('satisfied');
    expect(evaluateRuntimeAccess({ ...base, args: {} }, allowed).status).toBe('allowed');

    const highRoleId = '555566667777888899';
    const highRoutes = guildRoutes({
      [Routes.guildRoles(GUILD_ID)]: [
        {
          id: GUILD_ID,
          name: '@everyone',
          position: 0,
          permissions: String(PermissionFlagsBits.ManageRoles),
          managed: false,
        },
        { id: ROLE_ID, name: 'Bot', position: 5, permissions: '0', managed: false },
        { id: highRoleId, name: 'Higher', position: 8, permissions: '0', managed: false },
      ],
    });
    const highResolver = createRuntimeAccessResolver({
      rest: restFor(highRoutes).rest,
      expectedBotId: BOT_ID,
    });
    const denied = await highResolver({
      ...base,
      args: { guild_id: GUILD_ID, role_id: highRoleId },
    });
    expect(evaluateRuntimeAccess({ ...base, args: {} }, denied)).toMatchObject({
      status: 'denied',
      hierarchy: 'not_satisfied',
    });
  });

  it('evaluates the field-specific permission contract for members_modify', async () => {
    const targetUserId = '555566667777888899';
    const { rest } = restFor(
      guildRoutes({
        [Routes.guildRoles(GUILD_ID)]: [
          {
            id: GUILD_ID,
            name: '@everyone',
            position: 0,
            permissions: String(PermissionFlagsBits.ManageNicknames),
            managed: false,
          },
          {
            id: ROLE_ID,
            name: 'Bot',
            position: 5,
            permissions: String(PermissionFlagsBits.ModerateMembers),
            managed: false,
          },
        ],
        [Routes.guildMember(GUILD_ID, targetUserId)]: { user: { id: targetUserId }, roles: [] },
      }),
    );
    const resolver = createRuntimeAccessResolver({ rest, expectedBotId: BOT_ID });
    const requirement = getToolAccessRequirement('members_modify').requirement!;
    const evidence = await resolver({
      toolName: 'members_modify',
      args: { guild_id: GUILD_ID, user_id: targetUserId, nick: 'new-name' },
      requirement: {
        ...requirement,
        permissions: ['MANAGE_NICKNAMES'],
        hierarchy: 'required',
      },
      expectedBotId: BOT_ID,
    });
    expect(evidence.hierarchy).toBe('satisfied');
    expect(
      evaluateRuntimeAccess(
        {
          toolName: 'members_modify',
          args: { guild_id: GUILD_ID, user_id: targetUserId, nick: 'new-name' },
          requirement: {
            ...requirement,
            permissions: ['MANAGE_NICKNAMES'],
            hierarchy: 'required',
          },
          expectedBotId: BOT_ID,
        },
        evidence,
      ).status,
    ).toBe('allowed');
  });

  it('applies channel overwrites for guild-scoped operations that declare a permission target', async () => {
    const rolePermissions =
      PermissionFlagsBits.CreateEvents |
      PermissionFlagsBits.ManageChannels |
      PermissionFlagsBits.MuteMembers |
      PermissionFlagsBits.MoveMembers |
      PermissionFlagsBits.ViewChannel;
    const routes = guildRoutes({
      [Routes.guildRoles(GUILD_ID)]: [
        {
          id: GUILD_ID,
          name: '@everyone',
          position: 0,
          permissions: String(rolePermissions),
          managed: false,
        },
        { id: ROLE_ID, name: 'Bot', position: 5, permissions: '0', managed: false },
      ],
      [Routes.channel(CHANNEL_ID)]: {
        id: CHANNEL_ID,
        guild_id: GUILD_ID,
        type: 13,
        permission_overwrites: [
          { id: BOT_ID, type: 1, allow: '0', deny: String(PermissionFlagsBits.MoveMembers) },
        ],
      },
    });
    const { rest } = restFor(routes);
    const resolver = createRuntimeAccessResolver({ rest, expectedBotId: BOT_ID });
    const requirement = resolveToolAccessRequirement('events_create', {
      entity_type: 1,
      channel_id: CHANNEL_ID,
    });
    if (requirement === null) throw new Error('event requirement should resolve');
    const request = {
      toolName: 'events_create',
      args: { guild_id: GUILD_ID, entity_type: 1, channel_id: CHANNEL_ID },
      requirement,
      expectedBotId: BOT_ID,
    } satisfies RuntimeAccessRequest;
    const evidence = await resolver(request);
    expect(evidence.status).toBe('complete');
    expect(evaluateRuntimeAccess(request, evidence)).toMatchObject({
      status: 'denied',
      missingPermissions: ['MOVE_MEMBERS'],
    });
  });

  it('does not issue mutation methods', async () => {
    const { rest } = restFor(guildRoutes());
    const resolver = createRuntimeAccessResolver({ rest, expectedBotId: BOT_ID });
    await resolver({
      toolName: 'guild_get',
      args: { guild_id: GUILD_ID },
      requirement: GUILD_READ_ACCESS,
      expectedBotId: BOT_ID,
    });
    expect((rest as unknown as { post?: unknown }).post).toBeUndefined();
    expect((rest as unknown as { patch?: unknown }).patch).toBeUndefined();
    expect((rest as unknown as { delete?: unknown }).delete).toBeUndefined();
  });

  it('resolves invite targets before evaluating guild permissions', async () => {
    const { rest } = restFor({
      ...guildRoutes(),
      [Routes.invite('safe-code')]: { guild: { id: GUILD_ID } },
    });
    const resolver = createRuntimeAccessResolver({ rest, expectedBotId: BOT_ID });
    const evidence = await resolver({
      toolName: 'invites_delete',
      args: { code: 'safe-code' },
      requirement: getToolAccessRequirement('invites_delete').requirement!,
      expectedBotId: BOT_ID,
    });
    expect(evidence).toMatchObject({ status: 'complete', target: GUILD_ID });
  });

  it('fails closed for malformed identity, application, guild, role, and channel responses', async () => {
    const cases: Array<{
      readonly routes: Record<string, unknown>;
      readonly request: RuntimeAccessRequest;
    }> = [
      {
        routes: { [Routes.user('@me')]: null },
        request: {
          toolName: 'users_get_current',
          args: {},
          requirement: getToolAccessRequirement('users_get_current').requirement!,
          expectedBotId: BOT_ID,
        },
      },
      {
        routes: { [Routes.user('@me')]: { id: 'not-an-id', bot: true } },
        request: {
          toolName: 'users_get_current',
          args: {},
          requirement: getToolAccessRequirement('users_get_current').requirement!,
          expectedBotId: BOT_ID,
        },
      },
      {
        routes: {
          [Routes.user('@me')]: { id: BOT_ID, bot: true },
          [Routes.currentApplication()]: { id: BOT_ID, bot: { id: 'not-an-id' } },
        },
        request: {
          toolName: 'app_emojis_list',
          args: {},
          requirement: getToolAccessRequirement('app_emojis_list').requirement!,
          expectedBotId: BOT_ID,
        },
      },
      {
        routes: {
          ...identityRoutes(),
          [Routes.guild(GUILD_ID)]: { id: 'not-a-guild' },
          [Routes.guildMember(GUILD_ID, BOT_ID)]: { user: { id: BOT_ID }, roles: [] },
          [Routes.guildRoles(GUILD_ID)]: [],
        },
        request: {
          toolName: 'guild_get',
          args: { guild_id: GUILD_ID },
          requirement: GUILD_READ_ACCESS,
          expectedBotId: BOT_ID,
        },
      },
      {
        routes: {
          ...identityRoutes(),
          [Routes.guild(GUILD_ID)]: { id: GUILD_ID },
          [Routes.guildMember(GUILD_ID, BOT_ID)]: { user: { id: BOT_ID }, roles: [ROLE_ID] },
          [Routes.guildRoles(GUILD_ID)]: [{ id: GUILD_ID, position: 0, permissions: '0' }],
        },
        request: {
          toolName: 'roles_list',
          args: { guild_id: GUILD_ID },
          requirement: GUILD_READ_ACCESS,
          expectedBotId: BOT_ID,
        },
      },
      {
        routes: {
          ...guildRoutes({
            [Routes.channel(CHANNEL_ID)]: {
              id: CHANNEL_ID,
              guild_id: GUILD_ID,
              type: 0,
              permission_overwrites: [{ id: ROLE_ID, type: 0, allow: 'bad', deny: '0' }],
            },
          }),
        },
        request: {
          toolName: 'components_v2_send',
          args: { channel_id: CHANNEL_ID },
          requirement: CHANNEL_WRITE_ACCESS,
          expectedBotId: BOT_ID,
        },
      },
      {
        routes: {
          ...guildRoutes({
            [Routes.guildMember(GUILD_ID, BOT_ID)]: { user: { id: 'not-the-bot' }, roles: [] },
          }),
        },
        request: {
          toolName: 'guild_get',
          args: { guild_id: GUILD_ID },
          requirement: GUILD_READ_ACCESS,
          expectedBotId: BOT_ID,
        },
      },
      {
        routes: {
          ...guildRoutes({
            [Routes.guildRoles(GUILD_ID)]: [
              {
                id: GUILD_ID,
                name: '@everyone',
                position: 'high',
                permissions: '0',
                managed: false,
              },
            ],
          }),
        },
        request: {
          toolName: 'roles_list',
          args: { guild_id: GUILD_ID },
          requirement: GUILD_READ_ACCESS,
          expectedBotId: BOT_ID,
        },
      },
      {
        routes: {
          ...guildRoutes({
            [Routes.channel(CHANNEL_ID)]: {
              id: CHANNEL_ID,
              guild_id: GUILD_ID,
              type: 0,
              permission_overwrites: 'not-an-array',
            },
          }),
        },
        request: {
          toolName: 'components_v2_send',
          args: { channel_id: CHANNEL_ID },
          requirement: CHANNEL_WRITE_ACCESS,
          expectedBotId: BOT_ID,
        },
      },
      {
        routes: {
          ...guildRoutes({
            [Routes.currentApplication()]: { id: BOT_ID, bot: { id: 'not-the-bot' } },
          }),
        },
        request: {
          toolName: 'app_emojis_list',
          args: {},
          requirement: getToolAccessRequirement('app_emojis_list').requirement!,
          expectedBotId: BOT_ID,
        },
      },
    ];
    for (const testCase of cases) {
      const resolver = createRuntimeAccessResolver({
        rest: restFor(testCase.routes).rest,
        expectedBotId: BOT_ID,
      });
      await expect(resolver(testCase.request)).resolves.toMatchObject({ status: 'unknown' });
    }
  });

  it('handles webhook channels, thread parents, and missing invite guilds conservatively', async () => {
    const webhookId = '666677778888999900';
    const parentId = '777788889999000011';
    const { rest } = restFor({
      ...guildRoutes({
        [Routes.webhook(webhookId)]: { id: webhookId, channel_id: CHANNEL_ID },
        [Routes.channel(CHANNEL_ID)]: {
          id: CHANNEL_ID,
          guild_id: GUILD_ID,
          type: 11,
          parent_id: parentId,
        },
        [Routes.channel(parentId)]: {
          id: parentId,
          guild_id: GUILD_ID,
          type: 0,
          permission_overwrites: [],
        },
      }),
    });
    const resolver = createRuntimeAccessResolver({ rest, expectedBotId: BOT_ID });
    await expect(
      resolver({
        toolName: 'webhooks_get',
        args: { webhook_id: webhookId },
        requirement: getToolAccessRequirement('webhooks_get').requirement!,
        expectedBotId: BOT_ID,
      }),
    ).resolves.toMatchObject({ status: 'complete', target: `${GUILD_ID}/${CHANNEL_ID}` });

    const mismatchParentResolver = createRuntimeAccessResolver({
      rest: restFor({
        ...guildRoutes({
          [Routes.channel(CHANNEL_ID)]: {
            id: CHANNEL_ID,
            guild_id: GUILD_ID,
            type: 11,
            parent_id: parentId,
          },
          [Routes.channel(parentId)]: {
            id: parentId,
            guild_id: '999988887777666699',
            type: 0,
            permission_overwrites: [],
          },
        }),
      }).rest,
      expectedBotId: BOT_ID,
    });
    await expect(
      mismatchParentResolver({
        toolName: 'components_v2_send',
        args: { channel_id: CHANNEL_ID },
        requirement: CHANNEL_WRITE_ACCESS,
        expectedBotId: BOT_ID,
      }),
    ).resolves.toMatchObject({ status: 'unknown' });

    const inviteResolver = createRuntimeAccessResolver({
      rest: restFor({
        ...guildRoutes(),
        [Routes.invite('no-guild')]: { guild: null },
      }).rest,
      expectedBotId: BOT_ID,
    });
    await expect(
      inviteResolver({
        toolName: 'invites_get',
        args: { code: 'no-guild' },
        requirement: getToolAccessRequirement('invites_get').requirement!,
        expectedBotId: BOT_ID,
      }),
    ).resolves.toMatchObject({ status: 'unknown' });

    const noChannelWebhook = createRuntimeAccessResolver({
      rest: restFor({
        ...identityRoutes(),
        [Routes.webhook(webhookId)]: { id: webhookId, guild_id: GUILD_ID },
      }).rest,
      expectedBotId: BOT_ID,
    });
    await expect(
      noChannelWebhook({
        toolName: 'webhooks_get',
        args: { webhook_id: webhookId },
        requirement: getToolAccessRequirement('webhooks_get').requirement!,
        expectedBotId: BOT_ID,
      }),
    ).resolves.toMatchObject({ status: 'unknown' });
  });

  it('does not admit a resolver configured for a different bot identity', async () => {
    const { rest } = restFor(identityRoutes());
    const resolver = createRuntimeAccessResolver({
      rest,
      expectedBotId: '999988887777666699',
    });
    await expect(
      resolver({
        toolName: 'users_get_current',
        args: {},
        requirement: getToolAccessRequirement('users_get_current').requirement!,
        expectedBotId: '999988887777666699',
      }),
    ).resolves.toMatchObject({ status: 'unknown', identityVerified: true });
  });

  it('expires a short cache and clamps unsafe cache options', async () => {
    vi.useFakeTimers();
    try {
      const { rest, get } = restFor(identityRoutes());
      const resolver = createRuntimeAccessResolver({
        rest,
        cacheTtlMs: 120_000,
        maxCacheEntries: 0,
      });
      const request: RuntimeAccessRequest = {
        toolName: 'users_get_current',
        args: {},
        requirement: getToolAccessRequirement('users_get_current').requirement!,
        expectedBotId: BOT_ID,
      };
      await resolver(request);
      vi.advanceTimersByTime(60_001);
      await resolver(request);
      expect(get).toHaveBeenCalledTimes(2); // identity is re-read after the 60s clamp
    } finally {
      vi.useRealTimers();
    }
  });

  it('invalidates and bounds snapshots, and respects caller cancellation while a flight continues', async () => {
    const deferred: { resolve: (value: unknown) => void } = {
      resolve: () => undefined,
    };
    let identityCalls = 0;
    const get = vi.fn((path: string) => {
      if (path === Routes.user('@me')) {
        identityCalls += 1;
        if (identityCalls > 1) return Promise.resolve({ id: BOT_ID, bot: true });
        return new Promise((resolve) => {
          deferred.resolve = resolve;
        });
      }
      return Promise.resolve({ id: GUILD_ID });
    });
    const rest = { get } as unknown as REST;
    const resolver = createRuntimeAccessResolver({ rest, expectedBotId: BOT_ID, cacheTtlMs: 0 });
    const controller = new AbortController();
    const request: RuntimeAccessRequest = {
      toolName: 'users_get_current',
      args: {},
      requirement: getToolAccessRequirement('users_get_current').requirement!,
      expectedBotId: BOT_ID,
      signal: controller.signal,
    };
    const pending = resolver(request);
    controller.abort();
    await expect(pending).rejects.toBeDefined();
    deferred.resolve({ id: BOT_ID, bot: true });
    await expect(resolver({ ...request, signal: undefined })).resolves.toMatchObject({
      status: 'complete',
    });
    resolver.invalidate();
    await expect(resolver({ ...request, signal: undefined })).resolves.toMatchObject({
      status: 'complete',
    });
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('covers hierarchy edge cases and global identity-only evidence', async () => {
    const base = guildRoutes();
    const resolver = createRuntimeAccessResolver({
      rest: restFor(base).rest,
      expectedBotId: BOT_ID,
    });
    const createRole = await resolver({
      toolName: 'roles_create',
      args: { guild_id: GUILD_ID, name: 'new' },
      requirement: getToolAccessRequirement('roles_create').requirement!,
      expectedBotId: BOT_ID,
    });
    expect(createRole.hierarchy).toBe('satisfied');

    const missingEveryone = createRuntimeAccessResolver({
      rest: restFor(
        guildRoutes({
          [Routes.guildRoles(GUILD_ID)]: [
            {
              id: GUILD_ID,
              name: '@everyone',
              position: 0,
              permissions: '0',
              managed: false,
            },
          ],
        }),
      ).rest,
      expectedBotId: BOT_ID,
    });
    await expect(
      missingEveryone({
        toolName: 'roles_modify',
        args: { guild_id: GUILD_ID, role_id: TARGET_ROLE_ID },
        requirement: getToolAccessRequirement('roles_modify').requirement!,
        expectedBotId: BOT_ID,
      }),
    ).resolves.toMatchObject({ status: 'partial', hierarchy: 'unknown' });

    const global = createRuntimeAccessResolver({ rest: restFor(identityRoutes()).rest });
    await expect(
      global({
        toolName: 'users_list_current_user_guilds',
        args: {},
        requirement: getToolAccessRequirement('users_list_current_user_guilds').requirement!,
      }),
    ).resolves.toMatchObject({ status: 'complete', identityVerified: true, target: 'global' });

    const ownerResolver = createRuntimeAccessResolver({
      rest: restFor(
        guildRoutes({
          [Routes.guild(GUILD_ID)]: { id: GUILD_ID, owner_id: '999988887777666699' },
          [Routes.guildMember(GUILD_ID, '999988887777666699')]: {
            user: { id: '999988887777666699' },
            roles: [],
          },
        }),
      ).rest,
      expectedBotId: BOT_ID,
    });
    const ownerEvidence = await ownerResolver({
      toolName: 'members_kick',
      args: { guild_id: GUILD_ID, user_id: '999988887777666699' },
      requirement: getToolAccessRequirement('members_kick').requirement!,
      expectedBotId: BOT_ID,
    });
    expect(ownerEvidence.hierarchy).toBe('not_satisfied');

    const unknownRole = await resolver({
      toolName: 'roles_modify',
      args: { guild_id: GUILD_ID, role_id: TARGET_ROLE_ID },
      requirement: getToolAccessRequirement('roles_modify').requirement!,
      expectedBotId: BOT_ID,
    });
    expect(unknownRole.hierarchy).toBe('unknown');
  });

  it('exercises strict parser failures and target-member hierarchy reads', async () => {
    const malformedMember = createRuntimeAccessResolver({
      rest: restFor(
        guildRoutes({
          [Routes.guildMember(GUILD_ID, BOT_ID)]: null,
        }),
      ).rest,
      expectedBotId: BOT_ID,
    });
    await expect(
      malformedMember({
        toolName: 'guild_get',
        args: { guild_id: GUILD_ID },
        requirement: GUILD_READ_ACCESS,
        expectedBotId: BOT_ID,
      }),
    ).resolves.toMatchObject({ status: 'unknown' });

    const mismatchedApplication = createRuntimeAccessResolver({
      rest: restFor({
        [Routes.user('@me')]: { id: BOT_ID, bot: true },
        [Routes.currentApplication()]: { id: '999988887777666699' },
      }).rest,
      expectedBotId: BOT_ID,
    });
    await expect(
      mismatchedApplication({
        toolName: 'app_emojis_list',
        args: {},
        requirement: getToolAccessRequirement('app_emojis_list').requirement!,
        expectedBotId: BOT_ID,
      }),
    ).resolves.toMatchObject({ status: 'unknown' });

    const wrongNestedApplication = createRuntimeAccessResolver({
      rest: restFor({
        [Routes.user('@me')]: { id: BOT_ID, bot: true },
        [Routes.currentApplication()]: { id: BOT_ID, bot: { id: '999988887777666699' } },
      }).rest,
      expectedBotId: BOT_ID,
    });
    await expect(
      wrongNestedApplication({
        toolName: 'app_emojis_list',
        args: {},
        requirement: getToolAccessRequirement('app_emojis_list').requirement!,
        expectedBotId: BOT_ID,
      }),
    ).resolves.toMatchObject({ status: 'unknown' });

    const targetUserId = '888899990000111122';
    const targetMemberResolver = createRuntimeAccessResolver({
      rest: restFor(
        guildRoutes({
          [Routes.guildMember(GUILD_ID, targetUserId)]: { user: { id: targetUserId }, roles: [] },
        }),
      ).rest,
      expectedBotId: BOT_ID,
    });
    const targetEvidence = await targetMemberResolver({
      toolName: 'members_kick',
      args: { guild_id: GUILD_ID, user_id: targetUserId },
      requirement: getToolAccessRequirement('members_kick').requirement!,
      expectedBotId: BOT_ID,
    });
    expect(targetEvidence.hierarchy).toBe('satisfied');

    const channelGuildResolver = createRuntimeAccessResolver({
      rest: restFor(
        guildRoutes({
          [Routes.channel(CHANNEL_ID)]: {
            id: CHANNEL_ID,
            guild_id: GUILD_ID,
            type: 0,
            permission_overwrites: [],
          },
        }),
      ).rest,
      expectedBotId: BOT_ID,
    });
    await expect(
      channelGuildResolver({
        toolName: 'permissions_explain',
        args: { channel_id: CHANNEL_ID },
        requirement: getToolAccessRequirement('permissions_explain').requirement!,
        expectedBotId: BOT_ID,
      }),
    ).resolves.toMatchObject({ status: 'complete', target: GUILD_ID });

    const positionResolver = createRuntimeAccessResolver({
      rest: restFor(
        guildRoutes({
          [Routes.guildRoles(GUILD_ID)]: [
            {
              id: GUILD_ID,
              name: '@everyone',
              position: 0,
              permissions: String(PermissionFlagsBits.ManageRoles),
              managed: false,
            },
            { id: ROLE_ID, name: 'Bot', position: 5, permissions: '0', managed: false },
            { id: TARGET_ROLE_ID, name: 'Target', position: 2, permissions: '0', managed: false },
          ],
        }),
      ).rest,
      expectedBotId: BOT_ID,
    });
    await expect(
      positionResolver({
        toolName: 'roles_modify_positions',
        args: { guild_id: GUILD_ID, positions: [{ id: TARGET_ROLE_ID, position: 3 }] },
        requirement: getToolAccessRequirement('roles_modify_positions').requirement!,
        expectedBotId: BOT_ID,
      }),
    ).resolves.toMatchObject({ status: 'complete', hierarchy: 'satisfied' });

    const boundedGet = vi.fn(async (path: string) => {
      if (path === Routes.user('@me')) return { id: BOT_ID, bot: true };
      if (path === Routes.guild(GUILD_ID)) return { id: GUILD_ID };
      if (path === Routes.guildMember(GUILD_ID, BOT_ID))
        return { user: { id: BOT_ID }, roles: [ROLE_ID] };
      if (path === Routes.guildRoles(GUILD_ID))
        return [
          { id: GUILD_ID, name: '@everyone', position: 0, permissions: '0', managed: false },
          { id: ROLE_ID, name: 'Bot', position: 5, permissions: '0', managed: false },
        ];
      if (path.startsWith('/channels/')) {
        return {
          id: path.slice('/channels/'.length),
          guild_id: GUILD_ID,
          type: 0,
          permission_overwrites: [],
        };
      }
      throw new Error(`unexpected path ${path}`);
    });
    const boundedResolver = createRuntimeAccessResolver({
      rest: { get: boundedGet } as unknown as REST,
      expectedBotId: BOT_ID,
      maxCacheEntries: 16,
    });
    for (let index = 0; index < 18; index += 1) {
      await boundedResolver({
        toolName: 'components_v2_send',
        args: { channel_id: String(100000000000000000n + BigInt(index)) },
        requirement: CHANNEL_WRITE_ACCESS,
        expectedBotId: BOT_ID,
      });
    }
    expect(boundedGet).toHaveBeenCalled();
  });
});
