import { container } from '@sapphire/pieces';
import { Routes } from 'discord-api-types/v10';
import { z } from 'zod';
import { defineTool } from '../_lib/defineTool.js';
import { dualResult } from '../_lib/response.js';
import { WebhookId } from '../_lib/snowflake.js';

export default defineTool({
  name: 'webhooks_delete',
  category: 'webhooks',
  preconditions: ['confirm_required'] as const,
  description: [
    '**Purpose**: Delete a webhook by id. **DESTRUCTIVE - IRREVERSIBLE.**',
    '',
    '**When to use**:',
    '- Decommission a stale or compromised webhook.',
    '',
    '**Returns**: `{deleted, webhook_id}`. Pass `__confirm:true` AND set `MCP_DRY_RUN=false` to actually delete.',
  ].join('\n'),
  inputSchema: {
    webhook_id: WebhookId.describe('Webhook to delete'),
    audit_reason: z
      .string()
      .min(1)
      .max(512)
      .optional()
      .describe('Reason recorded in audit log (X-Audit-Log-Reason header)'),
  },
  outputSchema: {
    deleted: z.literal(true),
    webhook_id: WebhookId,
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  handler: async (args) => {
    await container.rest.delete(Routes.webhook(args.webhook_id), {
      reason: args.audit_reason,
    });
    return dualResult({
      text: `Deleted webhook \`${args.webhook_id}\`.`,
      data: {
        deleted: true as const,
        webhook_id: args.webhook_id,
      },
    });
  },
});
