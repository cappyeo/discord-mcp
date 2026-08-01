import { container } from '@sapphire/pieces';
import { Routes } from 'discord-api-types/v10';
import { z } from 'zod';
import { ValidationError } from '../../errors/client.js';
import { defineTool } from '../_lib/defineTool.js';
import { dualResult } from '../_lib/response.js';
import { ChannelId, MessageId } from '../_lib/snowflake.js';
import { validateComponentsV2 } from './_lib/validator.js';

const IS_COMPONENTS_V2 = 1 << 15;

export default defineTool({
  name: 'components_v2_edit',
  category: 'components_v2',
  description:
    '**Purpose**: Edit a Components V2 message previously sent by this bot. The `IS_COMPONENTS_V2` flag is irreversible - V2 messages stay V2.\n\n**Returns**: `{message_id, channel_id, edited_timestamp}`.',
  inputSchema: {
    channel_id: ChannelId,
    message_id: MessageId,
    components: z.array(z.unknown()).min(1).max(40),
  },
  outputSchema: {
    message_id: MessageId,
    channel_id: ChannelId,
    edited_timestamp: z.string(),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  handler: async (args) => {
    const validation = validateComponentsV2(args.components);
    if (!validation.valid) {
      throw new ValidationError(
        validation.issues.map((i) => ({ path: i.path, message: i.message, code: i.code })),
      );
    }
    const m = (await container.rest.patch(Routes.channelMessage(args.channel_id, args.message_id), {
      body: { flags: IS_COMPONENTS_V2, components: args.components },
    })) as { id: string; channel_id: string; edited_timestamp: string };
    return dualResult({
      text: `Edited V2 message ${m.id} in <#${m.channel_id}>.`,
      data: { message_id: m.id, channel_id: m.channel_id, edited_timestamp: m.edited_timestamp },
    });
  },
});
