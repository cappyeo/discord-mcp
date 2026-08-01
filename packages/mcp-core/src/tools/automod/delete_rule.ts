import { container } from '@sapphire/pieces';
import { Routes } from 'discord-api-types/v10';
import { z } from 'zod';
import { defineTool } from '../_lib/defineTool.js';
import { dualResult } from '../_lib/response.js';
import { AutoModRuleId, GuildId } from '../_lib/snowflake.js';

export default defineTool({
  name: 'automod_delete_rule',
  category: 'automod',
  preconditions: ['confirm_required'] as const,
  description: [
    '**Purpose**: Delete an AutoMod rule. **DESTRUCTIVE - IRREVERSIBLE.**',
    '',
    '**When to use**:',
    '- Permanently remove an obsolete rule.',
    '',
    '**When NOT to use**:',
    '- Temporarily disable → use `automod_modify_rule` with `enabled:false`.',
    '',
    '**Returns**: `{deleted, rule_id, guild_id}`.',
    '',
    '**Security**: gated by `ConfirmRequired`. Pass `__confirm:true` AND set `MCP_DRY_RUN=false` to actually delete.',
  ].join('\n'),
  inputSchema: {
    guild_id: GuildId.describe('Guild containing the rule'),
    rule_id: AutoModRuleId.describe('Rule to delete (IRREVERSIBLE)'),
    audit_reason: z
      .string()
      .min(1)
      .max(512)
      .optional()
      .describe('Reason recorded in audit log (X-Audit-Log-Reason header)'),
  },
  outputSchema: {
    deleted: z.literal(true),
    rule_id: AutoModRuleId,
    guild_id: GuildId,
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  handler: async (args) => {
    await container.rest.delete(Routes.guildAutoModerationRule(args.guild_id, args.rule_id), {
      reason: args.audit_reason,
    });
    return dualResult({
      text: `Deleted AutoMod rule \`${args.rule_id}\` from guild \`${args.guild_id}\`.`,
      data: { deleted: true as const, rule_id: args.rule_id, guild_id: args.guild_id },
    });
  },
});
