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
import { dualResult } from '../_lib/response.js';
import { ChannelId, Snowflake } from '../_lib/snowflake.js';

interface RawChannel extends ChannelTags {
  id: string;
  // `null` when the modified channel is a DM / unnamed group DM.
  name?: string | null;
  type: number;
  parent_id?: string | null;
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
    '**Forum tags**: Read `channels_get` first. `available_tags` is the complete desired set: keep IDs for existing tags; omit id only for additions. Every omitted existing ID must be listed in `remove_available_tag_ids`. Omitted emoji/moderated fields are preserved for existing IDs. The tool reads the current set before PATCH and refuses an incomplete state.',
    '',
    '**Emoji**: `emoji_id` is a guild emoji ID; application emoji compatibility is not guaranteed. To reuse application emoji artwork, upload it with `emojis_create` and use the resulting guild emoji ID. Set either emoji_id or emoji_name; set both to null to clear.',
    '',
    '**Verification**: Tag changes are read back after PATCH. After editing forum tags, read existing posts with `channels_get` or the active/archived thread lists to confirm their `applied_tags` still reference the retained IDs. Verification failure means PATCH succeeded: read current state before retrying.',
    '',
    "**Returns**: `{id, name, type, parent_id, available_tags?, applied_tags?, tags_verified?}`. `tags_verified:true` confirms this channel's tag readback only. `name` is `null` for DM / unnamed group DM channels.",
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
    if (changingTags) {
      current = (await container.rest.get(route, { signal: ctx.signal })) as RawChannel;
      if (args.available_tags !== undefined) {
        const requested = z.array(ForumTagInput).max(20).parse(args.available_tags);
        expectedTags = prepareForumTags(
          current.available_tags,
          requested,
          args.remove_available_tag_ids ?? [],
        );
        body.available_tags = expectedTags;
      } else {
        if (!z.array(Snowflake).safeParse(current.applied_tags).success) {
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
    if (changingTags) {
      let verified = false;
      try {
        c = (await container.rest.get(route, { signal: ctx.signal })) as RawChannel;
        verified =
          expectedTags !== undefined
            ? forumTagsMatch(current!.available_tags!, expectedTags, c.available_tags)
            : Array.isArray(c.applied_tags) &&
              JSON.stringify([...c.applied_tags].sort()) ===
                JSON.stringify([...args.applied_tags!].sort());
      } catch {
        // PATCH already succeeded. Never invite a blind retry (especially for additions).
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
        ...channelTags(c),
        ...(changingTags ? { tags_verified: true } : {}),
      },
    });
  },
});
