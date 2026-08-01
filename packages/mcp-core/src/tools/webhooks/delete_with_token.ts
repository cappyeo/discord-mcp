import { container } from '@sapphire/pieces';
import { Routes } from 'discord-api-types/v10';
import { z } from 'zod';
import { defineTool } from '../_lib/defineTool.js';
import { dualResult } from '../_lib/response.js';
import { WebhookId, WebhookToken } from '../_lib/snowflake.js';

export default defineTool({
  name: 'webhooks_delete_with_token',
  category: 'webhooks',
  preconditions: ['confirm_required'] as const,
  description: [
    '**Purpose**: Delete a webhook using its token. **DESTRUCTIVE - IRREVERSIBLE.**',
    '',
    '**When to use**:',
    '- Self-decommission when the agent only holds the token.',
    '',
    '**Auth**: NO `Authorization: Bot …` header. No `audit_reason` (Discord ignores it on token routes).',
    '',
    '**Returns**: `{deleted, webhook_id}`. Pass `__confirm:true` AND set `MCP_DRY_RUN=false` to actually delete.',
  ].join('\n'),
  inputSchema: {
    webhook_id: WebhookId.describe('Webhook to delete'),
    token: WebhookToken.describe('Webhook secret - treat as credential, do not log'),
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
    await container.rest.delete(Routes.webhook(args.webhook_id, args.token), {
      auth: false,
    });
    return dualResult({
      text: `Deleted webhook \`${args.webhook_id}\` (token-auth).`,
      data: {
        deleted: true as const,
        webhook_id: args.webhook_id,
      },
    });
  },
});
