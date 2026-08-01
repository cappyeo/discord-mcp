import { container } from '@sapphire/pieces';
import { Routes } from 'discord-api-types/v10';
import { z } from 'zod';
import { defineTool } from '../_lib/defineTool.js';
import { dualResult } from '../_lib/response.js';
import { ChannelId } from '../_lib/snowflake.js';

export default defineTool({
  name: 'channels_delete',
  category: 'channels',
  preconditions: ['confirm_required'] as const,
  description: [
    '**Purpose**: Delete a channel (or close a DM). **DESTRUCTIVE - IRREVERSIBLE.**',
    '',
    '**When to use**:',
    '- Tear down stale or compromised channels.',
    '',
    '**When NOT to use**:',
    '- Just hiding from a role → use `channels_modify_permissions`.',
    '',
    '**Returns**: `{deleted, channel_id}`.',
    '',
    '**Security**: gated by `ConfirmRequired`. Pass `__confirm:true` AND set `MCP_DRY_RUN=false` to actually delete.',
  ].join('\n'),
  inputSchema: {
    channel_id: ChannelId.describe('Channel to delete (IRREVERSIBLE)'),
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
    await container.rest.delete(Routes.channel(args.channel_id), { reason: args.audit_reason });
    return dualResult({
      text: `Deleted channel \`${args.channel_id}\`.`,
      data: { deleted: true as const, channel_id: args.channel_id },
    });
  },
});
