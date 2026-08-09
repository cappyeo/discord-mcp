import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { ChannelType, PermissionFlagsBits } from 'discord-api-types/v10';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import permissionsAuditChannel from './audit_channel.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';
const GUILD_ID = '999000999000999000';
const OTHER_GUILD_ID = '999000999000999001';
const CHANNEL_ID = '222233334444555566';
const THREAD_ID = '222233334444555577';
const PARENT_ID = '222233334444555588';
const VIEWER_ROLE_ID = '333344445555666611';
const CHATTER_ROLE_ID = '333344445555666622';
const MODERATOR_ROLE_ID = '333344445555666633';
const ADMIN_ROLE_ID = '333344445555666644';
const MEMBER_ID = '111122223333444455';

interface FixtureRole {
  id: string;
  name: string;
  position: number;
  permissions: string;
  managed?: boolean;
}

interface FixtureOverwrite {
  id: string;
  type: number;
  allow: string;
  deny: string;
}

interface FixtureChannel {
  id: string;
  type: number;
  guild_id?: string;
  parent_id?: string | null;
  permission_overwrites?: FixtureOverwrite[] | null;
}

interface RequestCounts {
  guild: number;
  roles: number;
  member: number;
  channel: number;
}

function bits(...permissions: bigint[]): string {
  return permissions.reduce((mask, permission) => mask | permission, 0n).toString();
}

function baseRoles(): FixtureRole[] {
  return [
    {
      id: GUILD_ID,
      name: '@everyone',
      position: 0,
      permissions: bits(PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages),
    },
    { id: VIEWER_ROLE_ID, name: 'Viewer', position: 4, permissions: '0' },
    { id: CHATTER_ROLE_ID, name: 'Chatter', position: 5, permissions: '0' },
    {
      id: MODERATOR_ROLE_ID,
      name: 'Moderator',
      position: 8,
      permissions: bits(PermissionFlagsBits.ManageChannels),
    },
    {
      id: ADMIN_ROLE_ID,
      name: 'Admin',
      position: 10,
      permissions: bits(PermissionFlagsBits.Administrator),
    },
  ];
}

function installFixture(options: {
  roles?: FixtureRole[];
  channels?: FixtureChannel[];
  channelResponses?: Readonly<Record<string, FixtureChannel>>;
}): RequestCounts {
  const counts: RequestCounts = { guild: 0, roles: 0, member: 0, channel: 0 };
  const roles = options.roles ?? baseRoles();
  const channels = options.channels ?? [
    {
      id: CHANNEL_ID,
      type: ChannelType.GuildText,
      guild_id: GUILD_ID,
      parent_id: null,
      permission_overwrites: [],
    },
  ];

  server.use(
    http.get(`${DISCORD_API}/guilds/:guildId/roles`, () => {
      counts.roles += 1;
      return HttpResponse.json(
        roles.map((role) => ({
          color: 0,
          hoist: false,
          mentionable: false,
          managed: role.managed ?? false,
          ...role,
        })),
      );
    }),
    http.get(`${DISCORD_API}/guilds/:guildId/members/:userId`, () => {
      counts.member += 1;
      return HttpResponse.json({ message: 'Unexpected member request' }, { status: 500 });
    }),
    http.get(`${DISCORD_API}/guilds/:guildId`, ({ params }) => {
      counts.guild += 1;
      return HttpResponse.json({ id: params.guildId, owner_id: MEMBER_ID });
    }),
    http.get(`${DISCORD_API}/channels/:channelId`, ({ params }) => {
      counts.channel += 1;
      const requestedId = String(params.channelId);
      const channel =
        options.channelResponses?.[requestedId] ??
        channels.find((candidate) => candidate.id === requestedId);
      return channel
        ? HttpResponse.json(channel)
        : HttpResponse.json({ message: 'Unknown Channel', code: 10003 }, { status: 404 });
    }),
  );
  return counts;
}

function outputShape(): Record<string, z.ZodTypeAny> {
  return (
    permissionsAuditChannel as unknown as {
      __toolMetadata: { outputSchema: Record<string, z.ZodTypeAny> };
    }
  ).__toolMetadata.outputSchema;
}

async function runAudit(args: Record<string, unknown>): Promise<{
  isError: boolean;
  content: Array<{ text: string }>;
  structuredContent: Record<string, unknown>;
}> {
  container.rest = new REST({ version: '10', makeRequest: fetch }).setToken(
    'fake-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  );
  const Tool = permissionsAuditChannel;
  const tool = new Tool(
    { name: 'permissions_audit_channel', path: 'inline', root: 'inline', store: null as never },
    { name: 'permissions_audit_channel', enabled: true },
  );
  return (await tool.run(args, { signal: new AbortController().signal })) as never;
}

describe('permissions_audit_channel', () => {
  it('audits every role independently and ignores member-specific overwrites', async () => {
    const counts = installFixture({
      channels: [
        {
          id: CHANNEL_ID,
          type: ChannelType.GuildText,
          guild_id: GUILD_ID,
          permission_overwrites: [
            {
              id: GUILD_ID,
              type: 0,
              allow: '0',
              deny: bits(PermissionFlagsBits.SendMessages),
            },
            {
              id: CHATTER_ROLE_ID,
              type: 0,
              allow: bits(PermissionFlagsBits.SendMessages),
              deny: '0',
            },
            {
              id: MEMBER_ID,
              type: 1,
              allow: bits(PermissionFlagsBits.SendMessages),
              deny: '0',
            },
          ],
        },
      ],
    });

    const result = await runAudit({ guild_id: GUILD_ID, channel_id: CHANNEL_ID });

    expect(result.isError).toBe(false);
    expect(result.structuredContent).toMatchObject({
      guild_id: GUILD_ID,
      channel_id: CHANNEL_ID,
      permission_source_channel_id: CHANNEL_ID,
      requested_actions: ['view_channel', 'send_messages', 'manage_channel'],
      member_overwrite_count: 1,
      confidence: 'complete',
      summary: {
        role_count: 5,
        by_action: {
          view_channel: { allowed: 5, denied: 0, unknown: 0 },
          send_messages: { allowed: 2, denied: 3, unknown: 0 },
          manage_channel: { allowed: 2, denied: 3, unknown: 0 },
        },
      },
    });
    expect(result.structuredContent.warnings).toEqual([
      expect.stringContaining('member-specific overwrite'),
    ]);
    expect(result.structuredContent.roles).toEqual([
      expect.objectContaining({
        id: ADMIN_ROLE_ID,
        administrator: true,
        actions: { view_channel: true, send_messages: true, manage_channel: true },
      }),
      expect.objectContaining({
        id: MODERATOR_ROLE_ID,
        actions: { view_channel: true, send_messages: false, manage_channel: true },
      }),
      expect.objectContaining({
        id: CHATTER_ROLE_ID,
        actions: { view_channel: true, send_messages: true, manage_channel: false },
      }),
      expect.objectContaining({
        id: VIEWER_ROLE_ID,
        actions: { view_channel: true, send_messages: false, manage_channel: false },
      }),
      expect.objectContaining({
        id: GUILD_ID,
        actions: { view_channel: true, send_messages: false, manage_channel: false },
      }),
    ]);
    expect(counts).toEqual({ guild: 0, roles: 1, member: 0, channel: 1 });
    expect(() => z.object(outputShape()).parse(result.structuredContent)).not.toThrow();
  });

  it('returns only requested actions to control output size', async () => {
    installFixture({});

    const result = await runAudit({
      guild_id: GUILD_ID,
      channel_id: CHANNEL_ID,
      actions: ['view_channel'],
    });

    expect(result.structuredContent).toMatchObject({
      requested_actions: ['view_channel'],
      summary: { by_action: { view_channel: { allowed: 5, denied: 0, unknown: 0 } } },
    });
    expect(
      Object.keys((result.structuredContent.summary as { by_action: object }).by_action),
    ).toEqual(['view_channel']);
    expect(
      (result.structuredContent.roles as Array<{ actions: object }>).every(
        (role) => Object.keys(role.actions).join(',') === 'view_channel',
      ),
    ).toBe(true);
  });

  it('deduplicates requested actions while preserving their order', async () => {
    installFixture({});

    const result = await runAudit({
      guild_id: GUILD_ID,
      channel_id: CHANNEL_ID,
      actions: ['view_channel', 'view_channel', 'send_messages'],
    });

    expect(result.structuredContent.requested_actions).toEqual(['view_channel', 'send_messages']);
    expect(
      Object.keys((result.structuredContent.summary as { by_action: object }).by_action),
    ).toEqual(['view_channel', 'send_messages']);
  });

  it('keeps administrator results known when channel overwrite evidence is missing', async () => {
    installFixture({
      channels: [{ id: CHANNEL_ID, type: ChannelType.GuildText, guild_id: GUILD_ID }],
    });

    const result = await runAudit({
      guild_id: GUILD_ID,
      channel_id: CHANNEL_ID,
      actions: ['send_messages'],
    });

    expect(result.structuredContent).toMatchObject({
      confidence: 'partial',
      summary: {
        by_action: { send_messages: { allowed: 1, denied: 0, unknown: 4 } },
      },
    });
    expect(result.structuredContent.roles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: ADMIN_ROLE_ID, actions: { send_messages: true } }),
        expect.objectContaining({ id: VIEWER_ROLE_ID, actions: { send_messages: null } }),
      ]),
    );
    expect(result.structuredContent.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining('permission_overwrites')]),
    );
  });

  it('marks the audit partial when Discord returns permission bits unknown to this build', async () => {
    const unknownBit = 1n << 100n;
    const roles = baseRoles().map((role) =>
      role.id === VIEWER_ROLE_ID
        ? { ...role, permissions: bits(PermissionFlagsBits.ViewChannel, unknownBit) }
        : role,
    );
    installFixture({ roles });

    const result = await runAudit({
      guild_id: GUILD_ID,
      channel_id: CHANNEL_ID,
      actions: ['view_channel'],
    });

    expect(result.structuredContent).toMatchObject({
      confidence: 'partial',
      unknown_permission_bits: unknownBit.toString(),
    });
    expect(result.structuredContent.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining('unknown to this build')]),
    );
  });

  it('uses parent overwrites and SEND_MESSAGES_IN_THREADS for a public thread', async () => {
    const roles = baseRoles().map((role) =>
      role.id === CHATTER_ROLE_ID
        ? {
            ...role,
            permissions: bits(
              PermissionFlagsBits.ViewChannel,
              PermissionFlagsBits.SendMessagesInThreads,
            ),
          }
        : role,
    );
    const counts = installFixture({
      roles,
      channels: [
        {
          id: THREAD_ID,
          type: ChannelType.PublicThread,
          guild_id: GUILD_ID,
          parent_id: PARENT_ID,
        },
        {
          id: PARENT_ID,
          type: ChannelType.GuildText,
          guild_id: GUILD_ID,
          permission_overwrites: [
            {
              id: GUILD_ID,
              type: 0,
              allow: '0',
              deny: bits(PermissionFlagsBits.SendMessagesInThreads),
            },
            {
              id: CHATTER_ROLE_ID,
              type: 0,
              allow: bits(PermissionFlagsBits.SendMessagesInThreads),
              deny: '0',
            },
          ],
        },
      ],
    });

    const result = await runAudit({
      guild_id: GUILD_ID,
      channel_id: THREAD_ID,
      actions: ['send_messages'],
    });

    expect(result.structuredContent).toMatchObject({
      permission_source_channel_id: PARENT_ID,
      confidence: 'complete',
    });
    expect(result.structuredContent.roles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: CHATTER_ROLE_ID, actions: { send_messages: true } }),
        expect.objectContaining({ id: GUILD_ID, actions: { send_messages: false } }),
      ]),
    );
    expect(counts).toEqual({ guild: 0, roles: 1, member: 0, channel: 2 });
  });

  it('uses MANAGE_THREADS rather than MANAGE_CHANNELS to manage a thread', async () => {
    const roles = baseRoles().map((role) => {
      if (role.id === MODERATOR_ROLE_ID) {
        return {
          ...role,
          permissions: bits(PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageThreads),
        };
      }
      if (role.id === VIEWER_ROLE_ID) {
        return {
          ...role,
          permissions: bits(PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageChannels),
        };
      }
      return role;
    });
    installFixture({
      roles,
      channels: [
        {
          id: THREAD_ID,
          type: ChannelType.PublicThread,
          guild_id: GUILD_ID,
          parent_id: PARENT_ID,
        },
        {
          id: PARENT_ID,
          type: ChannelType.GuildText,
          guild_id: GUILD_ID,
          permission_overwrites: [],
        },
      ],
    });

    const result = await runAudit({
      guild_id: GUILD_ID,
      channel_id: THREAD_ID,
      actions: ['manage_channel'],
    });

    expect(result.structuredContent.roles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: MODERATOR_ROLE_ID, actions: { manage_channel: true } }),
        expect.objectContaining({ id: VIEWER_ROLE_ID, actions: { manage_channel: false } }),
      ]),
    );
  });

  it('returns partial role results when a thread omits its parent', async () => {
    installFixture({
      channels: [
        {
          id: THREAD_ID,
          type: ChannelType.PublicThread,
          guild_id: GUILD_ID,
          parent_id: null,
        },
      ],
    });

    const result = await runAudit({
      guild_id: GUILD_ID,
      channel_id: THREAD_ID,
      actions: ['view_channel'],
    });

    expect(result.structuredContent).toMatchObject({
      permission_source_channel_id: null,
      confidence: 'partial',
      summary: { by_action: { view_channel: { allowed: 1, denied: 0, unknown: 4 } } },
    });
    expect(result.structuredContent.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining('parent_id')]),
    );
  });

  it('does not claim private-thread access without membership evidence', async () => {
    const roles = baseRoles().map((role) =>
      role.id === MODERATOR_ROLE_ID
        ? {
            ...role,
            permissions: bits(PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageThreads),
          }
        : role,
    );
    installFixture({
      roles,
      channels: [
        {
          id: THREAD_ID,
          type: ChannelType.PrivateThread,
          guild_id: GUILD_ID,
          parent_id: PARENT_ID,
        },
        {
          id: PARENT_ID,
          type: ChannelType.GuildText,
          guild_id: GUILD_ID,
          permission_overwrites: [],
        },
      ],
    });

    const result = await runAudit({
      guild_id: GUILD_ID,
      channel_id: THREAD_ID,
      actions: ['view_channel'],
    });

    expect(result.structuredContent).toMatchObject({
      confidence: 'partial',
      summary: { by_action: { view_channel: { allowed: 2, denied: 0, unknown: 3 } } },
    });
    expect(result.structuredContent.roles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: ADMIN_ROLE_ID, actions: { view_channel: true } }),
        expect.objectContaining({ id: MODERATOR_ROLE_ID, actions: { view_channel: true } }),
        expect.objectContaining({ id: VIEWER_ROLE_ID, actions: { view_channel: null } }),
      ]),
    );
    expect(result.structuredContent.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining('private-thread membership')]),
    );
  });

  it('still requires VIEW_CHANNEL when MANAGE_THREADS bypasses private-thread membership', async () => {
    const roles = baseRoles().map((role) =>
      role.id === MODERATOR_ROLE_ID
        ? { ...role, permissions: bits(PermissionFlagsBits.ManageThreads) }
        : role,
    );
    installFixture({
      roles,
      channels: [
        {
          id: THREAD_ID,
          type: ChannelType.PrivateThread,
          guild_id: GUILD_ID,
          parent_id: PARENT_ID,
        },
        {
          id: PARENT_ID,
          type: ChannelType.GuildText,
          guild_id: GUILD_ID,
          permission_overwrites: [
            {
              id: MODERATOR_ROLE_ID,
              type: 0,
              allow: '0',
              deny: bits(PermissionFlagsBits.ViewChannel),
            },
          ],
        },
      ],
    });

    const result = await runAudit({
      guild_id: GUILD_ID,
      channel_id: THREAD_ID,
      actions: ['view_channel'],
    });

    expect(result.structuredContent.roles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: MODERATOR_ROLE_ID, actions: { view_channel: false } }),
      ]),
    );
  });

  it('rejects a channel from another guild', async () => {
    installFixture({
      channels: [
        {
          id: CHANNEL_ID,
          type: ChannelType.GuildText,
          guild_id: OTHER_GUILD_ID,
          permission_overwrites: [],
        },
      ],
    });

    await expect(runAudit({ guild_id: GUILD_ID, channel_id: CHANNEL_ID })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });

  it('rejects a channel response whose identity does not match the request', async () => {
    installFixture({
      channelResponses: {
        [CHANNEL_ID]: {
          id: PARENT_ID,
          type: ChannelType.GuildText,
          guild_id: GUILD_ID,
          permission_overwrites: [],
        },
      },
    });

    await expect(runAudit({ guild_id: GUILD_ID, channel_id: CHANNEL_ID })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });

  it('rejects a thread parent response whose identity does not match parent_id', async () => {
    installFixture({
      channelResponses: {
        [THREAD_ID]: {
          id: THREAD_ID,
          type: ChannelType.PublicThread,
          guild_id: GUILD_ID,
          parent_id: PARENT_ID,
        },
        [PARENT_ID]: {
          id: CHANNEL_ID,
          type: ChannelType.GuildText,
          guild_id: GUILD_ID,
          permission_overwrites: [],
        },
      },
    });

    await expect(runAudit({ guild_id: GUILD_ID, channel_id: THREAD_ID })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });

  it('rejects malformed role permission bitfields without leaking a raw BigInt error', async () => {
    const roles = baseRoles();
    roles[1] = { ...roles[1], permissions: 'not-a-number' } as FixtureRole;
    installFixture({ roles });

    await expect(runAudit({ guild_id: GUILD_ID, channel_id: CHANNEL_ID })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });

  it.each([
    {
      name: 'null overwrite collection',
      permission_overwrites: null,
    },
    {
      name: 'unknown overwrite type',
      permission_overwrites: [{ id: VIEWER_ROLE_ID, type: 2, allow: '0', deny: '0' }],
    },
    {
      name: 'duplicate overwrite target',
      permission_overwrites: [
        { id: VIEWER_ROLE_ID, type: 0, allow: '0', deny: '0' },
        {
          id: VIEWER_ROLE_ID,
          type: 0,
          allow: bits(PermissionFlagsBits.ViewChannel),
          deny: '0',
        },
      ],
    },
    {
      name: 'overlapping allow and deny bits',
      permission_overwrites: [
        {
          id: VIEWER_ROLE_ID,
          type: 0,
          allow: bits(PermissionFlagsBits.ViewChannel),
          deny: bits(PermissionFlagsBits.ViewChannel),
        },
      ],
    },
  ])('rejects malformed channel evidence: $name', async ({ permission_overwrites }) => {
    installFixture({
      channels: [
        {
          id: CHANNEL_ID,
          type: ChannelType.GuildText,
          guild_id: GUILD_ID,
          permission_overwrites,
        },
      ],
    });

    await expect(runAudit({ guild_id: GUILD_ID, channel_id: CHANNEL_ID })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });
});
