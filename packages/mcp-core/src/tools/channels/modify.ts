import { container } from '@sapphire/pieces';
import { Routes } from 'discord-api-types/v10';
import { z } from 'zod';
import { defineTool } from '../_lib/defineTool.js';
import { CHANNEL_TYPE_VALUES } from '../_lib/discord-enums.js';
import { dualResult } from '../_lib/response.js';
import { ChannelId } from '../_lib/snowflake.js';

interface RawChannel {
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
    '**Returns**: `{id, name, type, parent_id}`. `name` is `null` for DM / unnamed group DM channels.',
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
      .array(
        z.object({
          id: z.string().optional(),
          name: z.string(),
          moderated: z.boolean().optional(),
          emoji_id: z.string().nullable().optional(),
          emoji_name: z.string().nullable().optional(),
        }),
      )
      .optional(),
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
  handler: async (args) => {
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
      'available_tags',
      'default_reaction_emoji',
      'default_thread_rate_limit_per_user',
      'default_sort_order',
      'default_forum_layout',
    ] as const;
    for (const key of passthrough) {
      const v = (args as Record<string, unknown>)[key];
      if (v !== undefined) body[key] = v;
    }
    const c = (await container.rest.patch(Routes.channel(args.channel_id), {
      body,
      reason: args.audit_reason,
    })) as RawChannel;
    const label =
      c.name !== null && c.name !== undefined ? `**#${c.name}**` : '_(unnamed channel)_';
    return dualResult({
      text: `Modified channel ${label} (\`channel:${c.id}\`).`,
      data: { id: c.id, name: c.name ?? null, type: c.type, parent_id: c.parent_id ?? null },
    });
  },
});
