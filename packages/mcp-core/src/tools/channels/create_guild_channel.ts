import { container } from '@sapphire/pieces';
import { Routes } from 'discord-api-types/v10';
import { z } from 'zod';
import { defineTool } from '../_lib/defineTool.js';
import { CHANNEL_TYPE_VALUES } from '../_lib/discord-enums.js';
import { dualResult } from '../_lib/response.js';
import { ChannelId, GuildId } from '../_lib/snowflake.js';

interface RawChannel {
  id: string;
  name: string;
  type: number;
  position?: number;
  parent_id?: string | null;
}

export default defineTool({
  name: 'channels_create_guild_channel',
  category: 'channels',
  description: [
    '**Purpose**: Create a new channel in a guild (text, voice, category, announcement, forum, etc.).',
    '',
    '**When to use**:',
    '- Programmatic guild bootstrap; tier-based channel provisioning.',
    '',
    '**When NOT to use**:',
    '- Threads - use `messages_create_thread`, `channels_forum_create_thread`, or thread-specific tools.',
    '',
    '**Type values** (from Discord API): 0 GUILD_TEXT, 2 GUILD_VOICE, 4 GUILD_CATEGORY, 5 GUILD_ANNOUNCEMENT, 13 GUILD_STAGE_VOICE, 14 GUILD_DIRECTORY, 15 GUILD_FORUM, 16 GUILD_MEDIA. Pick fields that match the type - extra fields are ignored by Discord.',
    '',
    '**Example**: `{guild_id:"…", name:"announcements", type:5, parent_id:"…"}`',
    '',
    '**Returns**: `{id, name, type, parent_id}`.',
  ].join('\n'),
  inputSchema: {
    guild_id: GuildId.describe('Target guild'),
    name: z
      .string()
      .min(1, 'name must be 1-100 chars')
      .max(100, 'name must be 1-100 chars')
      .describe('Channel name (1-100 chars)'),
    type: z
      .number()
      .int()
      .refine(
        (v): v is (typeof CHANNEL_TYPE_VALUES)[number] =>
          (CHANNEL_TYPE_VALUES as readonly number[]).includes(v),
        `type must be one of: ${CHANNEL_TYPE_VALUES.join(', ')}`,
      )
      .optional()
      .describe('Discord channel type (omit for default GUILD_TEXT=0)'),
    topic: z.string().max(1024).optional().describe('Channel topic (text/forum/announcement only)'),
    bitrate: z.number().int().min(8000).optional().describe('Voice bitrate in bps (voice/stage)'),
    user_limit: z
      .number()
      .int()
      .min(0)
      .max(99)
      .optional()
      .describe('Voice user cap (0 = no limit)'),
    rate_limit_per_user: z
      .number()
      .int()
      .min(0)
      .max(21600)
      .optional()
      .describe('Slowmode in seconds (0-21600)'),
    position: z.number().int().min(0).optional().describe('Sort position'),
    permission_overwrites: z
      .array(
        z.object({
          id: z.string(),
          type: z.number().int().min(0).max(1),
          allow: z.string().optional(),
          deny: z.string().optional(),
        }),
      )
      .optional()
      .describe('Permission overwrites to seed at creation'),
    parent_id: ChannelId.optional().describe('Category to nest under'),
    nsfw: z.boolean().optional().describe('Mark as NSFW'),
    rtc_region: z.string().optional().describe('Voice region override (voice/stage)'),
    video_quality_mode: z
      .union([z.literal(1), z.literal(2)])
      .optional()
      .describe('1 AUTO, 2 FULL (voice/stage)'),
    default_auto_archive_duration: z
      .union([z.literal(60), z.literal(1440), z.literal(4320), z.literal(10080)])
      .optional()
      .describe('Default thread auto-archive (60/1440/4320/10080 minutes)'),
    default_reaction_emoji: z
      .object({
        emoji_id: z.string().nullable().optional(),
        emoji_name: z.string().nullable().optional(),
      })
      .optional()
      .describe('Forum default reaction (emoji_id OR emoji_name)'),
    available_tags: z
      .array(
        z.object({
          name: z.string(),
          moderated: z.boolean().optional(),
          emoji_id: z.string().nullable().optional(),
          emoji_name: z.string().nullable().optional(),
        }),
      )
      .optional()
      .describe('Forum tag set'),
    default_sort_order: z
      .union([z.literal(0), z.literal(1)])
      .optional()
      .describe('Forum sort order (0 LATEST_ACTIVITY, 1 CREATION_DATE)'),
    default_forum_layout: z
      .union([z.literal(0), z.literal(1), z.literal(2)])
      .optional()
      .describe('Forum layout (0 NOT_SET, 1 LIST_VIEW, 2 GALLERY_VIEW)'),
    audit_reason: z
      .string()
      .min(1)
      .max(512)
      .optional()
      .describe('Reason recorded in audit log (X-Audit-Log-Reason header)'),
  },
  outputSchema: {
    id: ChannelId,
    name: z.string(),
    type: z.number().int(),
    parent_id: ChannelId.nullable(),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  handler: async (args) => {
    const body: Record<string, unknown> = { name: args.name };
    const passthrough = [
      'type',
      'topic',
      'bitrate',
      'user_limit',
      'rate_limit_per_user',
      'position',
      'permission_overwrites',
      'parent_id',
      'nsfw',
      'rtc_region',
      'video_quality_mode',
      'default_auto_archive_duration',
      'default_reaction_emoji',
      'available_tags',
      'default_sort_order',
      'default_forum_layout',
    ] as const;
    for (const key of passthrough) {
      const v = (args as Record<string, unknown>)[key];
      if (v !== undefined) body[key] = v;
    }
    const c = (await container.rest.post(Routes.guildChannels(args.guild_id), {
      body,
      reason: args.audit_reason,
    })) as RawChannel;
    return dualResult({
      text: `Created channel **#${c.name}** (\`channel:${c.id}\`, type ${c.type}).`,
      data: {
        id: c.id,
        name: c.name,
        type: c.type,
        parent_id: c.parent_id ?? null,
      },
    });
  },
});
