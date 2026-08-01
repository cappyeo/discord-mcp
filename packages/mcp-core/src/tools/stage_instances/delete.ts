import { container } from '@sapphire/pieces';
import { Routes } from 'discord-api-types/v10';
import { z } from 'zod';
import { defineTool } from '../_lib/defineTool.js';
import { dualResult } from '../_lib/response.js';
import { ChannelId } from '../_lib/snowflake.js';

export default defineTool({
  name: 'stage_instances_delete',
  category: 'stage_instances',
  preconditions: ['confirm_required'] as const,
  description: [
    '**Purpose**: End the live Stage instance for a channel. **DESTRUCTIVE - IRREVERSIBLE.**',
    '',
    '**When to use**: stop a stage talk.',
    '',
    '**Returns**: `{deleted, channel_id}`.',
    '',
    '**Security**: gated by `ConfirmRequired`. Pass `__confirm:true` AND set `MCP_DRY_RUN=false` to actually end.',
  ].join('\n'),
  inputSchema: {
    channel_id: ChannelId.describe('Stage channel whose instance to end'),
    audit_reason: z
      .string()
      .min(1)
      .max(512)
      .optional()
      .describe('Reason recorded in audit log (X-Audit-Log-Reason header)'),
  },
  outputSchema: {
    deleted: z.literal(true),
    channel_id: ChannelId,
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  handler: async (args) => {
    await container.rest.delete(Routes.stageInstance(args.channel_id), {
      reason: args.audit_reason,
    });
    return dualResult({
      text: `Ended stage instance for channel \`${args.channel_id}\`.`,
      data: { deleted: true as const, channel_id: args.channel_id },
    });
  },
});
