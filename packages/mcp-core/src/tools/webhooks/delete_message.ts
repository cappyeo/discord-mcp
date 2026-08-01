import { container } from '@sapphire/pieces';
import { Routes } from 'discord-api-types/v10';
import { z } from 'zod';
import { defineTool } from '../_lib/defineTool.js';
import { dualResult } from '../_lib/response.js';
import { ChannelId, MessageId, WebhookId, WebhookToken } from '../_lib/snowflake.js';

export default defineTool({
  name: 'webhooks_delete_message',
  category: 'webhooks',
  preconditions: ['confirm_required'] as const,
  description: [
    '**Purpose**: Delete a message previously sent by this webhook. **DESTRUCTIVE - IRREVERSIBLE.**',
    '',
    '**When to use**:',
    '- Retract a stale alert or accidentally posted content.',
    '',
    '**Auth**: NO `Authorization: Bot …` header. No `audit_reason` (Discord ignores it on token routes).',
    '',
    '**Returns**: `{deleted, message_id}`. Pass `__confirm:true` AND set `MCP_DRY_RUN=false` to actually delete.',
  ].join('\n'),
  inputSchema: {
    webhook_id: WebhookId.describe('Webhook id'),
    token: WebhookToken.describe('Webhook secret - treat as credential, do not log'),
    message_id: MessageId.describe('Message to delete'),
    thread_id: ChannelId.optional().describe('Query param: thread the message lives in'),
  },
  outputSchema: {
    deleted: z.literal(true),
    message_id: MessageId,
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  handler: async (args) => {
    const query = new URLSearchParams();
    if (args.thread_id !== undefined) query.set('thread_id', args.thread_id);
    await container.rest.delete(
      Routes.webhookMessage(args.webhook_id, args.token, args.message_id),
      { query, auth: false },
    );
    return dualResult({
      text: `Deleted webhook message \`${args.message_id}\`.`,
      data: {
        deleted: true as const,
        message_id: args.message_id,
      },
    });
  },
});
