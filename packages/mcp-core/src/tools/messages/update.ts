import { COMPOSER_UPDATE_ACCESS } from '../../access/requirements.js';
import { withAttribution, withAttributionComponents } from '../_lib/attribution.js';
import { defineTool } from '../_lib/defineTool.js';
import { dualResult } from '../_lib/response.js';
import { ChannelId, MessageId } from '../_lib/snowflake.js';
import { COMPOSER_INPUT_SCHEMA } from './_lib/composer.js';
import { DELIVERY_OUTPUT_SCHEMA, updateMessage } from './_lib/delivery.js';

export default defineTool({
  name: 'messages_update',
  category: 'messages',
  access: COMPOSER_UPDATE_ACCESS,
  confirmation: 'payload_hash',
  description:
    '**Purpose**: Update one rich announcement previously authored by this bot. Read the current message first, preserve omitted fields and existing attachments, append supplied files, and verify the changed fields independently.\n\n**When to use**: Correct an announcement, replace embed/layout content, or attach another file using its receipt message_id.\n\n**Limits**: One message per update; polls and TTS cannot be edited. Existing classic/V2 modes are preserved. New filenames must be distinct from retained attachments.\n\n**Approval**: Same exact payload_hash and one-time approval_id contract as messages_publish, bound to channel_id and message_id.\n\n**Returns**: complete or unverified and the updated message link/readback receipt.',
  inputSchema: { channel_id: ChannelId, message_id: MessageId, ...COMPOSER_INPUT_SCHEMA.shape },
  outputSchema: DELIVERY_OUTPUT_SCHEMA,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  handler: async (args, ctx) => {
    const data = await updateMessage(
      {
        ...args,
        ...(args.content === undefined
          ? {}
          : { content: withAttribution(args.content, ctx.caller, 'Updated') }),
        ...(args.components === undefined
          ? {}
          : { components: withAttributionComponents(args.components, ctx.caller, 'Updated') }),
      },
      ctx.signal,
    );
    return dualResult({ text: `Update ${data.status}. ${data.next_action}`, data });
  },
});
