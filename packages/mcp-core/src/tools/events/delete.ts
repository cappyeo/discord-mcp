import { container } from '@sapphire/pieces';
import { Routes } from 'discord-api-types/v10';
import { z } from 'zod';
import { defineTool } from '../_lib/defineTool.js';
import { dualResult } from '../_lib/response.js';
import { GuildId, ScheduledEventId } from '../_lib/snowflake.js';

export default defineTool({
  name: 'events_delete',
  category: 'events',
  preconditions: ['confirm_required'] as const,
  description: [
    '**Purpose**: Delete a scheduled event. **DESTRUCTIVE - IRREVERSIBLE.**',
    '',
    '**When to use**:',
    '- Cancel and remove a scheduled event entirely (vs. setting status=4 which keeps the record).',
    '',
    '**Returns**: `{deleted, event_id}`. Pass `__confirm:true` AND set `MCP_DRY_RUN=false` to actually delete.',
  ].join('\n'),
  inputSchema: {
    guild_id: GuildId.describe('Guild that owns the event'),
    event_id: ScheduledEventId.describe('Scheduled event id'),
    audit_reason: z
      .string()
      .min(1)
      .max(512)
      .optional()
      .describe('Reason recorded in audit log (X-Audit-Log-Reason header)'),
  },
  outputSchema: {
    deleted: z.literal(true),
    event_id: ScheduledEventId,
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  handler: async (args) => {
    await container.rest.delete(Routes.guildScheduledEvent(args.guild_id, args.event_id), {
      reason: args.audit_reason,
    });
    return dualResult({
      text: `Deleted scheduled event \`${args.event_id}\` from guild \`${args.guild_id}\`.`,
      data: { deleted: true as const, event_id: args.event_id },
    });
  },
});
