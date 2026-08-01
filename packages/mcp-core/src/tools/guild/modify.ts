import { container } from '@sapphire/pieces';
import { Routes } from 'discord-api-types/v10';
import { z } from 'zod';
import { defineTool } from '../_lib/defineTool.js';
import { dualResult } from '../_lib/response.js';
import { ChannelId, GuildId, UserId } from '../_lib/snowflake.js';
import { wrapUntrusted } from '../_lib/untrusted.js';

interface RawGuild {
  id: string;
  name: string;
  icon: string | null;
  owner_id: string;
  description: string | null;
  preferred_locale: string;
  features: string[];
}

export default defineTool({
  name: 'guild_modify',
  category: 'guild',
  description: [
    '**Purpose**: Update guild-level settings. Pass only fields you want to change.',
    '',
    '**When to use**:',
    '- Rename, change verification level, set system/rules/safety channels, toggle premium progress bar, etc.',
    '',
    '**When NOT to use**:',
    '- Channels → use `channels_modify`. Roles → use `roles_modify`. Welcome screen → use `guild_modify_welcome_screen`.',
    '',
    '**Returns**: projected guild shape `{id, name, icon, owner_id, description, preferred_locale, features, untrusted_text}`. `name` and `description` remain raw server-owner data; `untrusted_text` provides a separately fenced copy.',
  ].join('\n'),
  inputSchema: {
    guild_id: GuildId.describe('Guild to modify'),
    name: z.string().min(2).max(100).optional(),
    verification_level: z.number().int().min(0).max(4).optional(),
    default_message_notifications: z.number().int().min(0).max(1).optional(),
    explicit_content_filter: z.number().int().min(0).max(2).optional(),
    afk_channel_id: ChannelId.nullable().optional(),
    afk_timeout: z
      .union([z.literal(60), z.literal(300), z.literal(900), z.literal(1800), z.literal(3600)])
      .optional(),
    icon: z.string().nullable().optional().describe('base64 image data or null'),
    owner_id: UserId.optional().describe('Transfer ownership (must already be guild owner)'),
    splash: z.string().nullable().optional(),
    discovery_splash: z.string().nullable().optional(),
    banner: z.string().nullable().optional(),
    system_channel_id: ChannelId.nullable().optional(),
    system_channel_flags: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe('System channel flags bitfield (see Discord docs)'),
    rules_channel_id: ChannelId.nullable().optional(),
    public_updates_channel_id: ChannelId.nullable().optional(),
    preferred_locale: z.string().min(2).max(20).optional(),
    features: z.array(z.string()).optional(),
    description: z.string().max(300).nullable().optional(),
    premium_progress_bar_enabled: z.boolean().optional(),
    safety_alerts_channel_id: ChannelId.nullable().optional(),
    audit_reason: z
      .string()
      .min(1)
      .max(512)
      .optional()
      .describe('Reason recorded in audit log (X-Audit-Log-Reason header)'),
  },
  outputSchema: {
    id: GuildId,
    name: z.string(),
    icon: z.string().nullable(),
    owner_id: UserId,
    description: z.string().nullable(),
    preferred_locale: z.string(),
    features: z.array(z.string()),
    untrusted_text: z.string(),
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
      'verification_level',
      'default_message_notifications',
      'explicit_content_filter',
      'afk_channel_id',
      'afk_timeout',
      'icon',
      'owner_id',
      'splash',
      'discovery_splash',
      'banner',
      'system_channel_id',
      'system_channel_flags',
      'rules_channel_id',
      'public_updates_channel_id',
      'preferred_locale',
      'features',
      'description',
      'premium_progress_bar_enabled',
      'safety_alerts_channel_id',
    ] as const;
    for (const key of passthrough) {
      const v = (args as Record<string, unknown>)[key];
      if (v !== undefined) body[key] = v;
    }
    const g = (await container.rest.patch(Routes.guild(args.guild_id), {
      body,
      reason: args.audit_reason,
    })) as RawGuild;
    const wrapped = wrapUntrusted(
      JSON.stringify({ name: g.name, description: g.description }),
      'channel_topic',
    );
    return dualResult({
      text: `Modified guild \`${g.id}\` (name/description wrapped untrusted).`,
      data: {
        id: g.id,
        name: g.name,
        icon: g.icon,
        owner_id: g.owner_id,
        description: g.description,
        preferred_locale: g.preferred_locale,
        features: g.features,
        untrusted_text: wrapped,
      },
    });
  },
});
