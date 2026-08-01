import { container } from '@sapphire/pieces';
import { Routes } from 'discord-api-types/v10';
import { z } from 'zod';
import { defineTool } from '../_lib/defineTool.js';
import { dualResult } from '../_lib/response.js';
import { AutoModRuleId, ChannelId, GuildId, RoleId, UserId } from '../_lib/snowflake.js';
import { wrapUntrusted } from '../_lib/untrusted.js';

interface RawAction {
  type: number;
  metadata?: {
    channel_id?: string;
    duration_seconds?: number;
    custom_message?: string;
  };
}

interface RawRule {
  id: string;
  guild_id: string;
  name: string;
  creator_id: string;
  event_type: number;
  trigger_type: number;
  trigger_metadata?: {
    keyword_filter?: string[];
    regex_patterns?: string[];
    presets?: number[];
    allow_list?: string[];
    mention_total_limit?: number;
    mention_raid_protection_enabled?: boolean;
  };
  actions: RawAction[];
  enabled: boolean;
  exempt_roles: string[];
  exempt_channels: string[];
}

export default defineTool({
  name: 'automod_get_rule',
  category: 'automod',
  description: [
    '**Purpose**: Fetch a single AutoMod rule.',
    '',
    '**When to use**:',
    '- Inspect rule config before editing.',
    '',
    '**Returns**: full rule shape. `name` and trigger metadata remain raw user-authored data; `untrusted_text` provides a separately fenced copy.',
  ].join('\n'),
  inputSchema: {
    guild_id: GuildId.describe('Guild containing the rule'),
    rule_id: AutoModRuleId.describe('AutoMod rule to fetch'),
  },
  outputSchema: {
    id: AutoModRuleId,
    name: z.string(),
    creator_id: UserId,
    event_type: z.number().int(),
    trigger_type: z.number().int(),
    trigger_metadata: z.record(z.string(), z.unknown()).optional(),
    actions: z.array(z.record(z.string(), z.unknown())),
    enabled: z.boolean(),
    exempt_roles: z.array(RoleId),
    exempt_channels: z.array(ChannelId),
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
    const r = (await container.rest.get(
      Routes.guildAutoModerationRule(args.guild_id, args.rule_id),
    )) as RawRule;
    const untrusted = wrapUntrusted(
      JSON.stringify({
        name: r.name,
        keyword_filter: r.trigger_metadata?.keyword_filter ?? [],
        regex_patterns: r.trigger_metadata?.regex_patterns ?? [],
      }),
      'channel_topic',
    );
    return dualResult({
      text: `AutoMod rule \`${r.id}\` (trigger_type ${r.trigger_type}, ${r.actions.length} action(s), enabled=${r.enabled}).`,
      data: {
        id: r.id,
        name: r.name,
        creator_id: r.creator_id,
        event_type: r.event_type,
        trigger_type: r.trigger_type,
        trigger_metadata: r.trigger_metadata,
        actions: r.actions as unknown as Array<Record<string, unknown>>,
        enabled: r.enabled,
        exempt_roles: r.exempt_roles,
        exempt_channels: r.exempt_channels,
        untrusted_text: untrusted,
      },
    });
  },
});
