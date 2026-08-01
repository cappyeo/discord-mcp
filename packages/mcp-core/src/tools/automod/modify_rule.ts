import { container } from '@sapphire/pieces';
import { Routes } from 'discord-api-types/v10';
import { z } from 'zod';
import { defineTool } from '../_lib/defineTool.js';
import { dualResult } from '../_lib/response.js';
import { AutoModRuleId, ChannelId, GuildId, RoleId } from '../_lib/snowflake.js';
import { AutoModAction, AutoModEventType, AutoModTriggerMetadata } from './_lib.js';

interface RawRule {
  id: string;
  name: string;
  trigger_type: number;
  enabled: boolean;
}

export default defineTool({
  name: 'automod_modify_rule',
  category: 'automod',
  description: [
    "**Purpose**: Update an AutoMod rule's settings. Pass only fields you want to change.",
    '',
    '**When to use**:',
    '- Tweak keyword list, change actions, toggle enabled.',
    '',
    '**Note**: `trigger_type` is immutable - to change it, delete and recreate.',
    '',
    '**Returns**: `{id, name, trigger_type, enabled}`.',
  ].join('\n'),
  inputSchema: {
    guild_id: GuildId.describe('Guild containing the rule'),
    rule_id: AutoModRuleId.describe('Rule to modify'),
    name: z.string().min(1).max(100).optional(),
    event_type: AutoModEventType.optional(),
    trigger_metadata: AutoModTriggerMetadata.optional(),
    actions: z.array(AutoModAction).optional(),
    enabled: z.boolean().optional(),
    exempt_roles: z.array(RoleId).max(20).optional(),
    exempt_channels: z.array(ChannelId).max(50).optional(),
    audit_reason: z
      .string()
      .min(1)
      .max(512)
      .optional()
      .describe('Reason recorded in audit log (X-Audit-Log-Reason header)'),
  },
  outputSchema: {
    id: AutoModRuleId,
    name: z.string(),
    trigger_type: z.number().int(),
    enabled: z.boolean(),
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
      'event_type',
      'trigger_metadata',
      'actions',
      'enabled',
      'exempt_roles',
      'exempt_channels',
    ] as const;
    for (const key of passthrough) {
      const v = (args as Record<string, unknown>)[key];
      if (v !== undefined) body[key] = v;
    }
    const r = (await container.rest.patch(
      Routes.guildAutoModerationRule(args.guild_id, args.rule_id),
      { body, reason: args.audit_reason },
    )) as RawRule;
    return dualResult({
      text: `Modified AutoMod rule \`${r.id}\` (enabled=${r.enabled}).`,
      data: { id: r.id, name: r.name, trigger_type: r.trigger_type, enabled: r.enabled },
    });
  },
});
