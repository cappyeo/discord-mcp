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

const OnboardingSummarySchema = z.object({
  prompt_count: z.number().int().nonnegative(),
  required_prompt_count: z.number().int().nonnegative(),
  option_count: z.number().int().nonnegative(),
  default_channel_count: z.number().int().nonnegative(),
  self_assignable_role_count: z.number().int().nonnegative(),
  advanced_mode: z.boolean(),
  fresh_member_client_check_recommended: z.boolean(),
});

function onboardingSummary(onboarding: RawOnboarding) {
  const options = onboarding.prompts.flatMap((prompt) => prompt.options);
  const selfAssignableRoleIds = new Set(options.flatMap((option) => option.role_ids ?? []));
  return {
    prompt_count: onboarding.prompts.length,
    required_prompt_count: onboarding.prompts.filter((prompt) => prompt.required).length,
    option_count: options.length,
    default_channel_count: onboarding.default_channel_ids.length,
    self_assignable_role_count: selfAssignableRoleIds.size,
    advanced_mode: onboarding.mode === 1,
    // API readback proves the stored configuration, not how Discord will
    // present the questionnaire to a real new member in a client.
    fresh_member_client_check_recommended: onboarding.enabled && onboarding.prompts.length > 0,
  };
}

export default defineTool({
  name: 'onboarding_get',
  category: 'onboarding',
  description: [
    "**Purpose**: Fetch a guild's onboarding configuration.",
    '',
    '**Verification boundary**: This verifies Discord API readback only. When prompts are enabled, validate the actual join flow with a fresh non-staff member in a Discord client before declaring the member experience complete.',
    '',
    '**Returns**: `{guild_id, prompts, default_channel_ids, enabled, mode, summary, untrusted_text}`. Prompt and option text remains raw Discord data; `untrusted_text` provides a separately fenced copy.',
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
    summary: OnboardingSummarySchema,
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
    const summary = onboardingSummary(r);
    return dualResult({
      text:
        `Onboarding for guild \`${r.guild_id}\` (${summary.prompt_count} prompt(s), ` +
        `${summary.required_prompt_count} required, enabled=${r.enabled}). ` +
        (summary.fresh_member_client_check_recommended
          ? 'API readback passed; verify the actual flow with a fresh non-staff member in a Discord client.'
          : 'No fresh-member client verification is currently indicated.'),
      data: {
        guild_id: r.guild_id,
        prompts: r.prompts as unknown as Array<Record<string, unknown>>,
        default_channel_ids: r.default_channel_ids,
        enabled: r.enabled,
        mode: r.mode,
        summary,
        untrusted_text: wrapped,
      },
    });
  },
});
