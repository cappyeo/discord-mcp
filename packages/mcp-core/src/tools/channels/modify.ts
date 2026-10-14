import { container } from '@sapphire/pieces';
import { Routes } from 'discord-api-types/v10';
import { z } from 'zod';
import { ValidationError } from '../../errors/client.js';
import { defineTool } from '../_lib/defineTool.js';
import { CHANNEL_TYPE_VALUES } from '../_lib/discord-enums.js';
import {
  ChannelTagOutput,
  type ChannelTags,
  channelTags,
  ForumTagInput,
  forumTagsMatch,
  prepareForumTags,
} from '../_lib/forum-tags.js';
import { PermissionOverwrite } from '../_lib/permissions.js';
import { dualResult } from '../_lib/response.js';
import { ChannelId, GuildId, Snowflake } from '../_lib/snowflake.js';

interface RawChannel extends ChannelTags {
  id: string;
  // `null` when the modified channel is a DM / unnamed group DM.
  name?: string | null;
  type: number;
  parent_id?: string | null;
  guild_id?: string;
  permission_overwrites?: z.infer<typeof PermissionOverwrite>[];
}

const CategoryPermissions = z.object({
  id: ChannelId,
  guild_id: GuildId,
  type: z.literal(4),
  flags: z.number().int().optional(),
  permission_overwrites: z.array(PermissionOverwrite),
});

function overwritesMatch(
  expected: z.infer<typeof PermissionOverwrite>[],
  actual: unknown,
): boolean {
  const parsed = z.array(PermissionOverwrite).safeParse(actual);
  if (!parsed.success) return false;
  const canonical = (entries: z.infer<typeof PermissionOverwrite>[]) =>
    entries
      .map(({ id, type, allow, deny }) =>
        JSON.stringify([id, type, BigInt(allow).toString(), BigInt(deny).toString()]),
      )
      .sort();
  return JSON.stringify(canonical(expected)) === JSON.stringify(canonical(parsed.data));
}

export default defineTool({
  name: 'channels_modify',
  category: 'channels',
  description: [
    "**Purpose**: Update an existing channel's settings. Pass only the fields you want to change.",
    '',
    '**When to use**:',
    '- Rename, move under a category, toggle nsfw, change slowmode, retag a forum channel.',
    '',
    '**When NOT to use**:',
    '- Permission overwrites for a single role/user → use `channels_modify_permissions`.',
    '- Deleting → use `channels_delete`.',
    '',
    '**Field applicability** mirrors `channels_create_guild_channel`. Discord ignores fields that do not apply to the channel type.',
    '',
    '**Permission sync**: Set `lock_permissions:true` with an explicit category `parent_id` (the current parent for Sync Now, or a new parent to move and sync). This replaces every channel overwrite with the category set, including an empty set, using one PATCH as discord.js does. Requires VIEW_CHANNEL, MANAGE_CHANNELS and MANAGE_ROLES; the conservative preflight checks these on both channel and category. Do not also pass permission_overwrites. A false or omitted flag preserves ordinary modification behavior.',
    '',
    '**Permission verification**: Sync reads both channel and category after PATCH. `permissions_verified:true` means their parent and complete overwrite sets matched the copied category snapshot. A concurrent category change or unavailable readback returns a non-retriable verification error with `patch_succeeded:true`; read both channels before retrying.',
    '',
    '**Forum tags**: Read `channels_get` first. `available_tags` is the complete desired set: keep IDs for existing tags; omit id only for additions. Every omitted existing ID must be listed in `remove_available_tag_ids`. Omitted emoji/moderated fields are preserved for existing IDs. The tool reads the current set before PATCH and refuses an incomplete state.',
    '',
    '**Emoji**: `emoji_id` is a guild emoji ID; application emoji compatibility is not guaranteed. To reuse application emoji artwork, upload it with `emojis_create` and use the resulting guild emoji ID. Set either emoji_id or emoji_name; set both to null to clear.',
    '',
    '**Verification**: Tag changes are read back after PATCH. After editing forum tags, read existing posts with `channels_get` or the active/archived thread lists to confirm their `applied_tags` still reference the retained IDs. Verification failure means PATCH succeeded: read current state before retrying.',
    '',
    "**Returns**: `{id, name, type, parent_id, permission_overwrites?, permissions_verified?, available_tags?, applied_tags?, tags_verified?}`. `tags_verified:true` confirms this channel's tag readback only. `name` is `null` for DM / unnamed group DM channels.",
  ].join('\n'),
  inputSchema: {
    channel_id: ChannelId.describe('Channel to modify'),
    name: z.string().min(1).max(100).optional().describe('New channel name'),
    type: z
      .number()
      .int()
      .refine(
        (v): v is (typeof CHANNEL_TYPE_VALUES)[number] =>
          (CHANNEL_TYPE_VALUES as readonly number[]).includes(v),
        `type must be one of: ${CHANNEL_TYPE_VALUES.join(', ')}`,
      )
      .optional()
      .describe('Convert text↔announcement only (Discord limitation)'),
    position: z.number().int().min(0).optional(),
    topic: z.string().max(1024).nullable().optional(),
    nsfw: z.boolean().optional(),
    rate_limit_per_user: z.number().int().min(0).max(21600).optional(),
    bitrate: z.number().int().min(8000).optional(),
    user_limit: z.number().int().min(0).max(99).optional(),
    permission_overwrites: z
      .array(
        z.object({
          id: z.string(),
          type: z.number().int().min(0).max(1),
          allow: z.string().optional(),
          deny: z.string().optional(),
        }),
      )
      .optional(),
    parent_id: ChannelId.nullable().optional(),
    lock_permissions: z
      .boolean()
      .optional()
      .describe(
        'Copy the complete category overwrite set and verify it. True requires explicit non-null parent_id and excludes permission_overwrites.',
      ),
    rtc_region: z.string().nullable().optional(),
    video_quality_mode: z.union([z.literal(1), z.literal(2)]).optional(),
    default_auto_archive_duration: z
      .union([z.literal(60), z.literal(1440), z.literal(4320), z.literal(10080)])
      .optional(),
    flags: z.number().int().optional().describe('Channel flags bitfield'),
    available_tags: z
      .array(ForumTagInput)
      .max(20)
      .optional()
      .describe(
        'Complete desired tag set. Keep existing IDs; omit id for additions. Read channels_get first.',
      ),
    remove_available_tag_ids: z
      .array(Snowflake)
      .max(20)
      .optional()
      .describe(
        'Explicit IDs to delete from the current set; requires available_tags with those IDs omitted.',
      ),
    applied_tags: z
      .array(Snowflake)
      .max(5)
      .optional()
      .describe(
        'Complete desired tag IDs on a forum/media post. [] explicitly removes all post tags; omit to preserve.',
      ),
    default_reaction_emoji: z
      .object({
        emoji_id: z.string().nullable().optional(),
        emoji_name: z.string().nullable().optional(),
      })
      .nullable()
      .optional(),
    default_thread_rate_limit_per_user: z.number().int().min(0).max(21600).optional(),
    default_sort_order: z
      .union([z.literal(0), z.literal(1)])
      .nullable()
      .optional(),
    default_forum_layout: z.union([z.literal(0), z.literal(1), z.literal(2)]).optional(),
    audit_reason: z
      .string()
      .min(1)
      .max(512)
      .optional()
      .describe('Reason recorded in audit log (X-Audit-Log-Reason header)'),
  },
  outputSchema: {
    ...ChannelTagOutput,
    tags_verified: z.literal(true).optional(),
    permission_overwrites: z.array(PermissionOverwrite).optional(),
    permissions_verified: z.literal(true).optional(),
    id: ChannelId,
    name: z.string().nullable(),
    type: z.number().int(),
    parent_id: ChannelId.nullable(),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  handler: async (args, ctx) => {
    const syncingPermissions = args.lock_permissions === true;
    if (syncingPermissions && (!args.parent_id || args.permission_overwrites !== undefined)) {
      throw new ValidationError([
        {
          path: 'lock_permissions',
          message:
            'Requires an explicit category parent_id and cannot be combined with permission_overwrites.',
          code: 'custom',
        },
      ]);
    }
    const body: Record<string, unknown> = {};
    const passthrough = [
      'name',
      'type',
      'position',
      'topic',
      'nsfw',
      'rate_limit_per_user',
      'bitrate',
      'user_limit',
      'permission_overwrites',
      'parent_id',
      'rtc_region',
      'video_quality_mode',
      'default_auto_archive_duration',
      'flags',
      'default_reaction_emoji',
      'default_thread_rate_limit_per_user',
      'default_sort_order',
      'default_forum_layout',
    ] as const;
    for (const key of passthrough) {
      const v = (args as Record<string, unknown>)[key];
      if (v !== undefined) body[key] = v;
    }
    if (args.remove_available_tag_ids !== undefined && args.available_tags === undefined) {
      throw new ValidationError([
        {
          path: 'remove_available_tag_ids',
          message: 'Requires the complete desired available_tags list.',
          code: 'custom',
        },
      ]);
    }
    if (args.available_tags !== undefined && args.applied_tags !== undefined) {
      throw new ValidationError([
        {
          path: 'applied_tags',
          message: 'Edit available_tags on the parent forum and applied_tags on a post separately.',
          code: 'custom',
        },
      ]);
    }
    const route = Routes.channel(args.channel_id);
    const changingTags = args.available_tags !== undefined || args.applied_tags !== undefined;
    let current: RawChannel | undefined;
    let expectedTags: ReturnType<typeof prepareForumTags> | undefined;
    let expectedPermissions: z.infer<typeof PermissionOverwrite>[] | undefined;
    if (changingTags || syncingPermissions) {
      current = (await container.rest.get(route, { signal: ctx.signal })) as RawChannel;
    }
    if (syncingPermissions) {
      const parent = CategoryPermissions.safeParse(
        await container.rest.get(Routes.channel(args.parent_id!), { signal: ctx.signal }),
      );
      if (
        !current ||
        current.id !== args.channel_id ||
        ![0, 2, 5, 13, 15, 16].includes(current.type) ||
        !parent.success ||
        parent.data.id !== args.parent_id ||
        parent.data.guild_id !== current.guild_id ||
        ((parent.data.flags ?? 0) & (1 << 17)) !== 0
      ) {
        throw new ValidationError([
          {
            path: 'parent_id',
            message:
              'Cannot read a complete, visible category overwrite set in the target channel guild; no changes were made.',
            code: 'custom',
          },
        ]);
      }
      expectedPermissions = parent.data.permission_overwrites;
      body.permission_overwrites = expectedPermissions;
    }
    if (changingTags) {
      if (args.available_tags !== undefined) {
        const requested = z.array(ForumTagInput).max(20).parse(args.available_tags);
        expectedTags = prepareForumTags(
          current!.available_tags,
          requested,
          args.remove_available_tag_ids ?? [],
        );
        body.available_tags = expectedTags;
      } else {
        if (!z.array(Snowflake).safeParse(current!.applied_tags).success) {
          throw new ValidationError([
            {
              path: 'applied_tags',
              message: 'Cannot read the current post tags; no tags were changed.',
              code: 'custom',
            },
          ]);
        }
        body.applied_tags = z.array(Snowflake).max(5).parse(args.applied_tags);
      }
    }
    let c = (await container.rest.patch(route, {
      body,
      reason: args.audit_reason,
      signal: ctx.signal,
    })) as RawChannel;
    if (changingTags || syncingPermissions) {
      let verified = false;
      let permissionsVerified = false;
      try {
        c = (await container.rest.get(route, { signal: ctx.signal })) as RawChannel;
        verified =
          !changingTags ||
          (expectedTags !== undefined
            ? forumTagsMatch(current!.available_tags!, expectedTags, c.available_tags)
            : Array.isArray(c.applied_tags) &&
              JSON.stringify([...c.applied_tags].sort()) ===
                JSON.stringify([...args.applied_tags!].sort()));
        if (syncingPermissions) {
          const parent = CategoryPermissions.safeParse(
            await container.rest.get(Routes.channel(args.parent_id!), { signal: ctx.signal }),
          );
          permissionsVerified =
            c.id === args.channel_id &&
            c.guild_id === current!.guild_id &&
            c.parent_id === args.parent_id &&
            parent.success &&
            parent.data.id === args.parent_id &&
            parent.data.guild_id === current!.guild_id &&
            ((parent.data.flags ?? 0) & (1 << 17)) === 0 &&
            overwritesMatch(expectedPermissions!, c.permission_overwrites) &&
            overwritesMatch(expectedPermissions!, parent.data.permission_overwrites);
        }
      } catch {
        // PATCH already succeeded. Never invite a blind retry.
      }
      if (syncingPermissions && !permissionsVerified) {
        const recovery = `PATCH succeeded, but permission readback failed or differed. Read channels_get for ${args.channel_id} and category ${args.parent_id} before making another change.`;
        return {
          isError: true,
          content: [{ type: 'text' as const, text: recovery }],
          structuredContent: {
            code: 'PERMISSION_VERIFICATION_FAILED',
            category: 'server',
            retriable: false,
            recovery_hint: recovery,
            channel_id: args.channel_id,
            parent_id: args.parent_id,
            patch_succeeded: true,
          },
        };
      }
      if (!verified) {
        const recovery = `PATCH succeeded, but tag readback failed or differed. Read channels_get for ${args.channel_id} before making another change.`;
        return {
          isError: true,
          content: [{ type: 'text' as const, text: recovery }],
          structuredContent: {
            code: 'TAG_VERIFICATION_FAILED',
            category: 'server',
            retriable: false,
            recovery_hint: recovery,
            channel_id: args.channel_id,
            patch_succeeded: true,
          },
        };
      }
    }
    const label =
      c.name !== null && c.name !== undefined ? `**#${c.name}**` : '_(unnamed channel)_';
    return dualResult({
      text: `Modified channel ${label} (\`channel:${c.id}\`).`,
      data: {
        id: c.id,
        name: c.name ?? null,
        type: c.type,
        parent_id: c.parent_id ?? null,
        ...(c.permission_overwrites === undefined
          ? {}
          : { permission_overwrites: c.permission_overwrites }),
        ...(syncingPermissions ? { permissions_verified: true } : {}),
        ...channelTags(c),
        ...(changingTags ? { tags_verified: true } : {}),
      },
    });
  },
});
