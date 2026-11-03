import { COMPOSER_PUBLISH_ACCESS } from '../../access/requirements.js';
import { withAttribution } from '../_lib/attribution.js';
import { defineTool } from '../_lib/defineTool.js';
import { dualResult } from '../_lib/response.js';
import { ChannelId } from '../_lib/snowflake.js';
import { COMPOSER_INPUT_SCHEMA } from './_lib/composer.js';
import { DELIVERY_OUTPUT_SCHEMA, publishMessage } from './_lib/delivery.js';

export default defineTool({
  name: 'messages_publish',
  category: 'messages',
  access: COMPOSER_PUBLISH_ACCESS,
  confirmation: 'payload_hash',
  description:
    '**Purpose**: Publish a composed announcement through your Discord bot: text, embeds, file uploads, polls, and Components V2.\n\n**When to use**: Send the reviewed messages_compose draft to a channel.\n\n**Approval**: First call returns a bounded draft review, payload_hash, and one-time approval_id. With MCP_DRY_RUN=false, approve with __confirm:true, the unchanged __confirm_hash and __confirm_id.\n\n**Returns**: status, sent_count, and a link/readback receipt for every known sent part. partial or unverified is not completion; inspect receipts and channel history before preparing a fresh approval for missing parts. Never resend the whole draft after partial delivery.',
  inputSchema: {
    channel_id: ChannelId.describe('Channel where the reviewed draft will be published'),
    ...COMPOSER_INPUT_SCHEMA.shape,
  },
  outputSchema: DELIVERY_OUTPUT_SCHEMA,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  handler: async (args, ctx) => {
    const data = await publishMessage(
      { ...args, content: withAttribution(args.content, ctx.caller, 'Published') },
      ctx.signal,
    );
    return dualResult({
      text: `Publication ${data.status}: ${data.sent_count}/${data.requested_count} message part(s) sent. ${data.next_action}`,
      data,
    });
  },
});
