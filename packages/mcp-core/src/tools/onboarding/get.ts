import { container } from '@sapphire/pieces';
import { Routes } from 'discord-api-types/v10';
import { z } from 'zod';
import { defineTool } from '../_lib/defineTool.js';
import { dualResult } from '../_lib/response.js';
import { ChannelId, GuildId } from '../_lib/snowflake.js';
import { wrapUntrusted } from '../_lib/untrusted.js';

interface RawOption {
  id: string;
  title: string;
  description: string | null;
  channel_ids?: string[];
  role_ids?: string[];
  emoji?: { name?: string | null; id?: string | null; animated?: boolean };
}

interface RawPrompt {
  id: string;
  type: number;
  title: string;
  options: RawOption[];
  single_select: boolean;
  required: boolean;
  in_onboarding: boolean;
}

interface RawOnboarding {
  guild_id: string;
  prompts: RawPrompt[];
  default_channel_ids: string[];
  enabled: boolean;
  mode: number;
}

export default defineTool({
  name: 'onboarding_get',
  category: 'onboarding',
  description: [
    "**Purpose**: Fetch a guild's onboarding configuration.",
    '',
    '**Returns**: `{guild_id, prompts, default_channel_ids, enabled, mode, untrusted_text}`. Prompt and option text remains raw Discord data; `untrusted_text` provides a separately fenced copy.',
    '',
    'See: https://discord.com/developers/docs/resources/guild#guild-onboarding-object',
  ].join('\n'),
  inputSchema: {
    guild_id: GuildId.describe('Guild whose onboarding config to fetch'),
  },
  outputSchema: {
    guild_id: GuildId,
    prompts: z.array(z.record(z.string(), z.unknown())),
    default_channel_ids: z.array(ChannelId),
    enabled: z.boolean(),
    mode: z.number().int(),
    untrusted_text: z.string(),
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  idempotent: true,
  handler: async (args) => {
    const r = (await container.rest.get(Routes.guildOnboarding(args.guild_id))) as RawOnboarding;
    const promptDigest = r.prompts.map((p) => ({
      title: p.title,
      options: p.options.map((o) => ({ title: o.title, description: o.description })),
    }));
    const wrapped = wrapUntrusted(JSON.stringify(promptDigest), 'channel_topic');
    return dualResult({
      text: `Onboarding for guild \`${r.guild_id}\` (${r.prompts.length} prompt(s), enabled=${r.enabled}).`,
      data: {
        guild_id: r.guild_id,
        prompts: r.prompts as unknown as Array<Record<string, unknown>>,
        default_channel_ids: r.default_channel_ids,
        enabled: r.enabled,
        mode: r.mode,
        untrusted_text: wrapped,
      },
    });
  },
});
