import { container } from '@sapphire/pieces';
import { Routes } from 'discord-api-types/v10';
import { z } from 'zod';
import { defineTool } from '../_lib/defineTool.js';
import { dualResult } from '../_lib/response.js';
import { ChannelId, GuildId } from '../_lib/snowflake.js';

interface RawOnboarding {
  guild_id: string;
  enabled: boolean;
  mode: number;
}

export default defineTool({
  name: 'onboarding_modify',
  category: 'onboarding',
  description: [
    "**Purpose**: Replace a guild's onboarding configuration (PUT — full replace).",
    '',
    '`prompts` is an array of Discord-shaped prompt objects. See:',
    'https://docs.discord.com/developers/resources/guild#guild-onboarding-object-onboarding-prompt-structure',
    '',
    '**Enabling requirements**: Discord requires at least 7 default channels, and at least 5 must allow `@everyone` to send messages. The generated reference uses a safe disabled configuration; replace it with real channel IDs before setting `enabled:true`.',
    '',
    '**Returns**: `{guild_id, enabled, mode}`.',
  ].join('\n'),
  inputSchema: {
    guild_id: GuildId.describe('Target guild'),
    prompts: z
      .array(z.record(z.string(), z.unknown()))
      .describe('Onboarding prompts (full replace) — see Discord docs for prompt object shape'),
    default_channel_ids: z
      .array(ChannelId)
      .describe('Channels members see by default after onboarding'),
    enabled: z.boolean().describe('Whether onboarding is enabled'),
    mode: z
      .number()
      .int()
      .describe('Onboarding mode (0 ONBOARDING_DEFAULT, 1 ONBOARDING_ADVANCED)'),
    audit_reason: z
      .string()
      .min(1)
      .max(512)
      .optional()
      .describe('Reason recorded in audit log (X-Audit-Log-Reason header)'),
  },
  outputSchema: {
    guild_id: GuildId,
    enabled: z.boolean(),
    mode: z.number().int(),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  idempotent: true,
  handler: async (args) => {
    const body = {
      prompts: args.prompts,
      default_channel_ids: args.default_channel_ids,
      enabled: args.enabled,
      mode: args.mode,
    };
    const r = (await container.rest.put(Routes.guildOnboarding(args.guild_id), {
      body,
      reason: args.audit_reason,
    })) as RawOnboarding;
    return dualResult({
      text: `Modified onboarding for guild \`${r.guild_id}\` (enabled=${r.enabled}, mode=${r.mode}).`,
      data: { guild_id: r.guild_id, enabled: r.enabled, mode: r.mode },
    });
  },
});
