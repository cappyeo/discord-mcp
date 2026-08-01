import { container } from '@sapphire/pieces';
import { Routes } from 'discord-api-types/v10';
import { z } from 'zod';
import { defineTool } from '../_lib/defineTool.js';
import { dualResult } from '../_lib/response.js';
import { ApplicationId, WebhookToken } from '../_lib/snowflake.js';

export default defineTool({
  name: 'interactions_delete_original_response',
  category: 'interactions',
  preconditions: ['confirm_required'] as const,
  description: [
    '**Purpose**: Delete the original interaction response message. **DESTRUCTIVE — IRREVERSIBLE.**',
    '',
    '**Auth**: token-secured (NO bot token).',
    '',
    '**Returns**: `{deleted}`. Pass `__confirm:true` AND `MCP_DRY_RUN=false` to actually delete.',
  ].join('\n'),
  inputSchema: {
    application_id: ApplicationId.describe('Bot/app application ID'),
    interaction_token: WebhookToken.describe(
      'Scoped interaction credential, reusable for follow-ups for up to 15 minutes',
    ),
  },
  outputSchema: {
    deleted: z.literal(true),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  handler: async (args) => {
    await container.rest.delete(
      Routes.webhookMessage(args.application_id, args.interaction_token, '@original'),
      { auth: false },
    );
    return dualResult({
      text: 'Deleted original interaction response.',
      data: { deleted: true as const },
    });
  },
});
