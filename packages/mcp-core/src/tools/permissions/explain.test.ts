import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import permissionsExplain from './explain.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';
const GUILD_ID = '999000999000999000';
const OWNER_ID = '111122223333444400';
const USER_ID = '111122223333444455';
const TARGET_USER_ID = '111122223333444466';
const CHANNEL_ID = '222233334444555566';
const THREAD_ID = '222233334444555577';
const PARENT_ID = '222233334444555588';
const ACTOR_ROLE_ID = '333344445555666677';
const SECOND_ROLE_ID = '333344445555666688';
const TARGET_ROLE_ID = '333344445555666600';

interface FixtureRole {
  id: string;
  name: string;
  position: number;
  permissions: string;
  managed?: boolean;
}

interface FixtureOverwrite {
  id: string;
  type: 0 | 1;
  allow: string;
  deny: string;
}

interface FixtureChannel {
  id: string;
  type: number;
  guild_id?: string;
  parent_id?: string | null;
  permission_overwrites?: FixtureOverwrite[];
}

interface FixtureOptions {
  ownerId?: string;
  roles: FixtureRole[];
  actorRoleIds?: string[];
  targetRoleIds?: string[];
  actorTimeout?: string | null;
  channels?: FixtureChannel[];
}

function installFixture(options: FixtureOptions): void {
  const channels = options.channels ?? [
    {
      id: CHANNEL_ID,
      type: 0,
      guild_id: GUILD_ID,
      parent_id: null,
      permission_overwrites: [],
    },
  ];
  server.use(
    http.get(`${DISCORD_API}/guilds/:guildId`, ({ params }) =>
      HttpResponse.json({ id: params.guildId, owner_id: options.ownerId ?? OWNER_ID }),
    ),
    http.get(`${DISCORD_API}/guilds/:guildId/roles`, () =>
      HttpResponse.json(
        options.roles.map((role) => ({
          color: 0,
          hoist: false,
          mentionable: false,
          managed: role.managed ?? false,
          ...role,
        })),
      ),
    ),
    http.get(`${DISCORD_API}/guilds/:guildId/members/:userId`, ({ params }) =>
      HttpResponse.json({
        user: { id: params.userId, username: 'fixture-user', avatar: null },
        roles:
          params.userId === TARGET_USER_ID
            ? (options.targetRoleIds ?? [TARGET_ROLE_ID])
            : (options.actorRoleIds ?? [ACTOR_ROLE_ID]),
        communication_disabled_until:
          params.userId === TARGET_USER_ID ? null : (options.actorTimeout ?? null),
        joined_at: '2026-01-01T00:00:00.000Z',
      }),
    ),
    http.get(`${DISCORD_API}/channels/:channelId`, ({ params }) => {
      const channel = channels.find((candidate) => candidate.id === params.channelId);
      return channel
        ? HttpResponse.json(channel)
        : HttpResponse.json({ message: 'Unknown Channel', code: 10003 }, { status: 404 });
    }),
  );
}

function baseRoles(overrides: Partial<Record<string, Partial<FixtureRole>>> = {}): FixtureRole[] {
  const roles: FixtureRole[] = [
    { id: GUILD_ID, name: '@everyone', position: 0, permissions: '0' },
    { id: ACTOR_ROLE_ID, name: 'Actor', position: 10, permissions: '0' },
    { id: SECOND_ROLE_ID, name: 'Second', position: 9, permissions: '0' },
    { id: TARGET_ROLE_ID, name: 'Target', position: 5, permissions: '0' },
  ];
  return roles.map((role) => ({ ...role, ...overrides[role.id] }));
}

function outputShape(): Record<string, z.ZodTypeAny> {
  return (
    permissionsExplain as unknown as {
      __toolMetadata: { outputSchema: Record<string, z.ZodTypeAny> };
    }
  ).__toolMetadata.outputSchema;
}

async function runExplain(args: Record<string, unknown>): Promise<{
  isError: boolean;
  content: Array<{ text: string }>;
  structuredContent: Record<string, unknown>;
}> {
  container.rest = new REST({ version: '10', makeRequest: fetch }).setToken(
    'fake-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  );
  const Tool = permissionsExplain;
  const tool = new Tool(
    { name: 'permissions_explain', path: 'inline', root: 'inline', store: null as never },
    { name: 'permissions_explain', enabled: true },
  );
  return (await tool.run(args, { signal: new AbortController().signal })) as never;
}

describe('permissions_explain', () => {
  it('applies everyone, combined role, and member overwrites in Discord order', async () => {
    installFixture({
      roles: baseRoles({ [GUILD_ID]: { permissions: '1024' } }),
      actorRoleIds: [ACTOR_ROLE_ID, SECOND_ROLE_ID],
      channels: [
        {
          id: CHANNEL_ID,
          type: 0,
          guild_id: GUILD_ID,
          permission_overwrites: [
            { id: GUILD_ID, type: 0, allow: '0', deny: '2048' },
            { id: ACTOR_ROLE_ID, type: 0, allow: '2048', deny: '0' },
            { id: SECOND_ROLE_ID, type: 0, allow: '34816', deny: '2048' },
            { id: USER_ID, type: 1, allow: '0', deny: '32768' },
          ],
        },
      ],
    });

    const result = await runExplain({
      guild_id: GUILD_ID,
      channel_id: CHANNEL_ID,
      user_id: USER_ID,
      requested_permissions: ['SEND_MESSAGES', 'ATTACH_FILES'],
    });

    expect(result.isError).toBe(false);
    expect(result.structuredContent).toMatchObject({
      allowed: false,
      base_permissions: '1024',
      effective_permissions: '3072',
      missing_permissions: ['ATTACH_FILES'],
      ineffective_permissions: [],
      confidence: 'complete',
    });
    expect(
      (result.structuredContent.decision_trace as Array<{ stage: string }>).map(
        ({ stage }) => stage,
      ),
    ).toEqual([
      'guild_everyone',
      'guild_roles',
      'channel_everyone',
      'channel_roles',
      'channel_member',
    ]);
    expect(() => z.object(outputShape()).parse(result.structuredContent)).not.toThrow();
  });

  it('lets ADMINISTRATOR bypass channel overwrites', async () => {
    installFixture({
      roles: baseRoles({ [ACTOR_ROLE_ID]: { permissions: '8' } }),
      channels: [
        {
          id: CHANNEL_ID,
          type: 0,
          guild_id: GUILD_ID,
          permission_overwrites: [{ id: GUILD_ID, type: 0, allow: '0', deny: '3076' }],
        },
      ],
    });

    const result = await runExplain({
      guild_id: GUILD_ID,
      channel_id: CHANNEL_ID,
      user_id: USER_ID,
      requested_permissions: ['VIEW_CHANNEL', 'SEND_MESSAGES', 'BAN_MEMBERS'],
    });

    expect(result.structuredContent).toMatchObject({
      allowed: true,
      administrator: true,
      missing_permissions: [],
    });
    expect(
      (result.structuredContent.decision_trace as Array<{ stage: string }>).map(
        ({ stage }) => stage,
      ),
    ).toEqual(['guild_everyone', 'guild_roles', 'administrator']);
  });

  it('lets the guild owner bypass permission bits and role positions', async () => {
    installFixture({
      ownerId: USER_ID,
      roles: baseRoles({
        [ACTOR_ROLE_ID]: { position: 1 },
        [TARGET_ROLE_ID]: { position: 10 },
      }),
    });

    const result = await runExplain({
      guild_id: GUILD_ID,
      user_id: USER_ID,
      action: 'kick_member',
      target_user_id: TARGET_USER_ID,
    });

    expect(result.structuredContent).toMatchObject({
      allowed: true,
      guild_owner: true,
      administrator: false,
      missing_permissions: [],
      role_hierarchy_check: { status: 'allowed', allowed: true },
    });
    expect(
      (result.structuredContent.decision_trace as Array<{ stage: string }>).map(
        ({ stage }) => stage,
      ),
    ).toEqual(['guild_everyone', 'guild_roles', 'guild_owner']);
  });

  it('marks a set channel permission ineffective when VIEW_CHANNEL is absent', async () => {
    installFixture({
      roles: baseRoles({ [TARGET_ROLE_ID]: { permissions: '32768' } }),
    });

    const result = await runExplain({
      guild_id: GUILD_ID,
      channel_id: CHANNEL_ID,
      role_id: TARGET_ROLE_ID,
      requested_permissions: ['ATTACH_FILES'],
    });

    expect(result.structuredContent).toMatchObject({
      allowed: false,
      missing_permissions: [],
      ineffective_permissions: ['ATTACH_FILES'],
      confidence: 'complete',
    });
    expect(result.structuredContent.implicit_denies).toEqual([
      expect.objectContaining({
        permission: 'ATTACH_FILES',
        missing_prerequisites: ['VIEW_CHANNEL', 'SEND_MESSAGES'],
      }),
    ]);
  });

  it('returns unknown when a member references a role absent from the guild role list', async () => {
    const missingRoleId = '333344445555666700';
    installFixture({ roles: baseRoles(), actorRoleIds: [missingRoleId] });

    const result = await runExplain({
      guild_id: GUILD_ID,
      user_id: USER_ID,
      requested_permissions: ['KICK_MEMBERS'],
    });

    expect(result.structuredContent).toMatchObject({
      allowed: null,
      confidence: 'partial',
      missing_permissions: ['KICK_MEMBERS'],
    });
    expect(result.structuredContent.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining(missingRoleId)]),
    );
  });

  it('returns unknown when a guild channel omits permission overwrites', async () => {
    installFixture({
      roles: baseRoles({ [GUILD_ID]: { permissions: '3072' } }),
      channels: [{ id: CHANNEL_ID, type: 0, guild_id: GUILD_ID }],
    });

    const result = await runExplain({
      guild_id: GUILD_ID,
      channel_id: CHANNEL_ID,
      user_id: USER_ID,
      action: 'send_messages',
    });

    expect(result.structuredContent).toMatchObject({ allowed: null, confidence: 'partial' });
    expect(result.structuredContent.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining('permission_overwrites')]),
    );
  });

  it('rejects a non-guild channel instead of evaluating it in the requested guild', async () => {
    installFixture({
      roles: baseRoles(),
      channels: [{ id: CHANNEL_ID, type: 1, permission_overwrites: [] }],
    });

    await expect(
      runExplain({
        guild_id: GUILD_ID,
        channel_id: CHANNEL_ID,
        user_id: USER_ID,
        requested_permissions: ['VIEW_CHANNEL'],
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('uses the parent channel overwrites and SEND_MESSAGES_IN_THREADS for a thread', async () => {
    installFixture({
      roles: baseRoles({
        [GUILD_ID]: { permissions: '1024' },
        [ACTOR_ROLE_ID]: { permissions: '274877906944' },
      }),
      channels: [
        { id: THREAD_ID, type: 11, guild_id: GUILD_ID, parent_id: PARENT_ID },
        {
          id: PARENT_ID,
          type: 0,
          guild_id: GUILD_ID,
          permission_overwrites: [
            { id: GUILD_ID, type: 0, allow: '0', deny: '274877906944' },
            { id: ACTOR_ROLE_ID, type: 0, allow: '274877906944', deny: '0' },
          ],
        },
      ],
    });

    const result = await runExplain({
      guild_id: GUILD_ID,
      channel_id: THREAD_ID,
      user_id: USER_ID,
      action: 'send_messages',
    });

    expect(result.structuredContent).toMatchObject({
      allowed: true,
      permission_source_channel_id: PARENT_ID,
      requested_permissions: ['VIEW_CHANNEL', 'SEND_MESSAGES_IN_THREADS'],
    });
  });

  it('returns unknown for private-thread membership that REST payloads cannot prove', async () => {
    installFixture({
      roles: baseRoles({
        [GUILD_ID]: { permissions: '1024' },
        [ACTOR_ROLE_ID]: { permissions: '274877906944' },
      }),
      channels: [
        { id: THREAD_ID, type: 12, guild_id: GUILD_ID, parent_id: PARENT_ID },
        { id: PARENT_ID, type: 0, guild_id: GUILD_ID, permission_overwrites: [] },
      ],
    });

    const result = await runExplain({
      guild_id: GUILD_ID,
      channel_id: THREAD_ID,
      user_id: USER_ID,
      action: 'send_messages',
    });

    expect(result.structuredContent).toMatchObject({ allowed: null, confidence: 'partial' });
    expect(result.structuredContent.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining('private-thread membership')]),
    );
  });

  it('keeps other private-thread channel permissions unknown without membership evidence', async () => {
    installFixture({
      roles: baseRoles({
        [GUILD_ID]: { permissions: '33792' },
        [ACTOR_ROLE_ID]: { permissions: '274877906944' },
      }),
      channels: [
        { id: THREAD_ID, type: 12, guild_id: GUILD_ID, parent_id: PARENT_ID },
        { id: PARENT_ID, type: 0, guild_id: GUILD_ID, permission_overwrites: [] },
      ],
    });

    const result = await runExplain({
      guild_id: GUILD_ID,
      channel_id: THREAD_ID,
      user_id: USER_ID,
      requested_permissions: ['ATTACH_FILES'],
    });

    expect(result.structuredContent).toMatchObject({
      allowed: null,
      confidence: 'partial',
      missing_permissions: [],
      ineffective_permissions: [],
    });
  });

  it('recognizes current voice-channel permission bits and their CONNECT prerequisite', async () => {
    installFixture({
      roles: baseRoles({ [GUILD_ID]: { permissions: '281474976711680' } }),
      channels: [
        {
          id: CHANNEL_ID,
          type: 2,
          guild_id: GUILD_ID,
          permission_overwrites: [],
        },
      ],
    });

    const result = await runExplain({
      guild_id: GUILD_ID,
      channel_id: CHANNEL_ID,
      user_id: USER_ID,
      requested_permissions: ['SET_VOICE_CHANNEL_STATUS'],
    });

    expect(result.structuredContent).toMatchObject({
      allowed: false,
      missing_permissions: [],
      ineffective_permissions: ['SET_VOICE_CHANNEL_STATUS'],
    });
    expect(result.structuredContent.implicit_denies).toEqual([
      expect.objectContaining({
        permission: 'SET_VOICE_CHANNEL_STATUS',
        missing_prerequisites: ['CONNECT'],
      }),
    ]);
  });

  it('applies Discord active-timeout restrictions to a member subject', async () => {
    installFixture({
      roles: baseRoles({ [GUILD_ID]: { permissions: '3072' } }),
      actorTimeout: '2099-01-01T00:00:00.000Z',
    });

    const result = await runExplain({
      guild_id: GUILD_ID,
      channel_id: CHANNEL_ID,
      user_id: USER_ID,
      action: 'send_messages',
    });

    expect(result.structuredContent).toMatchObject({
      allowed: false,
      subject_timed_out: true,
      effective_permissions: '1024',
      missing_permissions: ['SEND_MESSAGES'],
    });
    expect(
      (result.structuredContent.decision_trace as Array<{ stage: string }>).map(
        ({ stage }) => stage,
      ),
    ).toContain('member_timeout');
  });

  it('combines MANAGE_ROLES with target-role hierarchy for role assignment', async () => {
    installFixture({
      roles: baseRoles({ [ACTOR_ROLE_ID]: { permissions: '268435456', position: 10 } }),
    });

    const result = await runExplain({
      guild_id: GUILD_ID,
      user_id: USER_ID,
      action: 'assign_role',
      target_role_id: TARGET_ROLE_ID,
    });

    expect(result.structuredContent).toMatchObject({
      allowed: true,
      requested_permissions: ['MANAGE_ROLES'],
      role_hierarchy_check: {
        status: 'allowed',
        allowed: true,
        actor_top_role_id: ACTOR_ROLE_ID,
        target_top_role_id: TARGET_ROLE_ID,
      },
    });
  });

  it('denies assigning a Discord-managed role even when the actor is higher', async () => {
    installFixture({
      roles: baseRoles({
        [ACTOR_ROLE_ID]: { permissions: '268435456', position: 10 },
        [TARGET_ROLE_ID]: { managed: true, position: 5 },
      }),
    });

    const result = await runExplain({
      guild_id: GUILD_ID,
      user_id: USER_ID,
      action: 'assign_role',
      target_role_id: TARGET_ROLE_ID,
    });

    expect(result.structuredContent).toMatchObject({
      allowed: false,
      missing_permissions: [],
      role_hierarchy_check: { status: 'denied', allowed: false },
    });
    expect((result.structuredContent.role_hierarchy_check as { reason: string }).reason).toContain(
      'managed',
    );
  });

  it('denies moderation when the target member has an equal top-role position', async () => {
    installFixture({
      roles: baseRoles({
        [ACTOR_ROLE_ID]: { permissions: '2', position: 10 },
        [TARGET_ROLE_ID]: { position: 10 },
      }),
    });

    const result = await runExplain({
      guild_id: GUILD_ID,
      user_id: USER_ID,
      action: 'kick_member',
      target_user_id: TARGET_USER_ID,
    });

    expect(result.structuredContent).toMatchObject({
      allowed: false,
      missing_permissions: [],
      role_hierarchy_check: {
        status: 'denied',
        allowed: false,
        actor_top_role_id: ACTOR_ROLE_ID,
        target_top_role_id: TARGET_ROLE_ID,
      },
    });
  });

  it('denies timing out a member whose resolved roles grant ADMINISTRATOR', async () => {
    installFixture({
      roles: baseRoles({
        [ACTOR_ROLE_ID]: { permissions: '1099511627776', position: 10 },
        [TARGET_ROLE_ID]: { permissions: '8', position: 5 },
      }),
    });

    const result = await runExplain({
      guild_id: GUILD_ID,
      user_id: USER_ID,
      action: 'timeout_member',
      target_user_id: TARGET_USER_ID,
    });

    expect(result.structuredContent).toMatchObject({
      allowed: false,
      missing_permissions: [],
      role_hierarchy_check: { status: 'denied', allowed: false },
    });
    expect((result.structuredContent.role_hierarchy_check as { reason: string }).reason).toContain(
      'ADMINISTRATOR',
    );
  });

  it('rejects an ambiguous subject instead of guessing', async () => {
    installFixture({ roles: baseRoles() });

    await expect(
      runExplain({
        guild_id: GUILD_ID,
        user_id: USER_ID,
        role_id: ACTOR_ROLE_ID,
        requested_permissions: ['VIEW_CHANNEL'],
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});
