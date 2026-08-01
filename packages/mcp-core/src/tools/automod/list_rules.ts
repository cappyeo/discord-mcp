import { container } from '@sapphire/pieces';
import { Routes } from 'discord-api-types/v10';
import { z } from 'zod';
import { defineTool } from '../_lib/defineTool.js';
import { dualResult } from '../_lib/response.js';
import { AutoModRuleId, GuildId } from '../_lib/snowflake.js';
import { wrapUntrusted } from '../_lib/untrusted.js';

interface RawRule {
  id: string;
  guild_id: string;
  name: string;
  trigger_type: number;
  event_type: number;
  enabled: boolean;
}

export default defineTool({
  name: 'automod_list_rules',
  category: 'automod',
  description: [
    '**Purpose**: List all AutoMod rules in a guild.',
    '',
    '**When to use**:',
    '- Audit existing rules; find a rule ID before modifying/deleting it.',
    '',
    '**Returns**: `{rules:[{id, name, trigger_type, event_type, enabled}], count, untrusted_names}`. Rule names remain raw user-authored data; `untrusted_names` provides a separately fenced copy.',
  ].join('\n'),
  inputSchema: {
    guild_id: GuildId.describe('Guild to list AutoMod rules for'),
  },
  outputSchema: {
    rules: z.array(
      z.object({
        id: AutoModRuleId,
        name: z.string(),
        trigger_type: z.number().int(),
        event_type: z.number().int(),
        enabled: z.boolean(),
      }),
    ),
    count: z.number().int(),
    untrusted_names: z.string(),
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  idempotent: true,
  handler: async (args) => {
    const raw = (await container.rest.get(
      Routes.guildAutoModerationRules(args.guild_id),
    )) as RawRule[];
    const rules = raw.map((r) => ({
      id: r.id,
      name: r.name,
      trigger_type: r.trigger_type,
      event_type: r.event_type,
      enabled: r.enabled,
    }));
    const untrusted = wrapUntrusted(
      JSON.stringify(raw.map((r) => ({ id: r.id, name: r.name }))),
      'channel_topic',
    );
    return dualResult({
      text: `Found ${rules.length} AutoMod rule(s) in guild \`${args.guild_id}\`.`,
      data: { rules, count: rules.length, untrusted_names: untrusted },
    });
  },
});
