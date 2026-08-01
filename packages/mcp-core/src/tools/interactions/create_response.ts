import { container } from '@sapphire/pieces';
import { Routes } from 'discord-api-types/v10';
import { z } from 'zod';
import { defineTool } from '../_lib/defineTool.js';
import { dualResult } from '../_lib/response.js';
import { InteractionId, WebhookToken } from '../_lib/snowflake.js';

export default defineTool({
  name: 'interactions_create_response',
  category: 'interactions',
  description: [
    '**Purpose**: Send the initial response to an interaction (slash command, button, modal submit, etc.).',
    '',
    '**3-SECOND DEADLINE**: Discord rejects this response if not received within 3 seconds of the interaction event. If you need more time, respond with type=5 (DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE) and follow up via `interactions_edit_original_response` or `interactions_create_followup`.',
    '',
    '**Auth**: token-secured; no bot token. The initial callback may be sent once. Its interaction token remains a scoped continuation credential for follow-ups for up to 15 minutes, unless the initial 3-second deadline is missed.',
    '',
    '**INTERACTION_RESPONSE_TYPE values**: 1=PONG, 4=CHANNEL_MESSAGE_WITH_SOURCE, 5=DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE, 6=DEFERRED_UPDATE_MESSAGE, 7=UPDATE_MESSAGE, 8=APPLICATION_COMMAND_AUTOCOMPLETE_RESULT, 9=MODAL, 10=PREMIUM_REQUIRED (deprecated), 12=LAUNCH_ACTIVITY.',
    '',
    '**Returns**: `{acknowledged:true}` (or `{message:…}` when `with_response:true`).',
  ].join('\n'),
  inputSchema: {
    interaction_id: InteractionId.describe(
      'Interaction ID (snowflake) - from the interaction event',
    ),
    interaction_token: WebhookToken.describe(
      'Scoped interaction credential, reusable for follow-ups for up to 15 minutes. Treat as a credential.',
    ),
    type: z
      .union([
        z.literal(1),
        z.literal(4),
        z.literal(5),
        z.literal(6),
        z.literal(7),
        z.literal(8),
        z.literal(9),
        z.literal(10),
        z.literal(12),
      ])
      .describe(
        'INTERACTION_RESPONSE_TYPE (1=PONG, 4=MESSAGE, 5=DEFER, 9=MODAL, 10=PREMIUM, 12=ACTIVITY)',
      ),
    data: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        'Response payload - shape depends on `type`. Message body for type=4; modal for type=9.',
      ),
    with_response: z
      .boolean()
      .optional()
      .describe('When true, server returns the resulting message body. Query param.'),
  },
  outputSchema: {
    acknowledged: z.boolean(),
    message: z.record(z.string(), z.unknown()).optional(),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  handler: async (args) => {
    const body: Record<string, unknown> = { type: args.type };
    if (args.data !== undefined) body.data = args.data;
    const query = new URLSearchParams();
    if (args.with_response !== undefined) query.set('with_response', String(args.with_response));

    const result = (await container.rest.post(
      Routes.interactionCallback(args.interaction_id, args.interaction_token),
      { body, query, auth: false },
    )) as Record<string, unknown> | null;

    if (args.with_response === true && result !== null) {
      return dualResult({
        text: `Acknowledged interaction \`${args.interaction_id}\` (type=${args.type}, with response).`,
        data: { acknowledged: true, message: result },
      });
    }
    return dualResult({
      text: `Acknowledged interaction \`${args.interaction_id}\` (type=${args.type}).`,
      data: { acknowledged: true },
    });
  },
});
