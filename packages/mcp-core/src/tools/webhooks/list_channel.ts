import { container } from '@sapphire/pieces';
import { Routes } from 'discord-api-types/v10';
import { z } from 'zod';
import { defineTool } from '../_lib/defineTool.js';
import { dualResult } from '../_lib/response.js';
import { ApplicationId, ChannelId, WebhookId } from '../_lib/snowflake.js';
import { wrapUntrusted } from '../_lib/untrusted.js';

interface RawWebhook {
  id: string;
  name: string | null;
  type: number;
  channel_id: string | null;
  application_id: string | null;
  avatar: string | null;
}

export default defineTool({
  name: 'webhooks_list_channel',
  category: 'webhooks',
  description:
    '**Purpose**: List webhooks attached to a single channel.\n\n**When to use**: discover webhooks before sending via `webhooks_execute`; audit a channel for unauthorized webhooks.\n\n**Returns**: `{webhooks:[{id,name,type,channel_id,application_id}], count}`. Structured names remain raw creator-controlled data; the human-readable text response fences them.',
  inputSchema: {
    channel_id: ChannelId.describe('Channel to query'),
  },
  outputSchema: {
    webhooks: z.array(
      z.object({
        id: WebhookId,
        name: z.string().nullable(),
        type: z.number().int(),
        channel_id: ChannelId.nullable(),
        application_id: ApplicationId.nullable(),
      }),
    ),
    count: z.number(),
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  idempotent: true,
  handler: async (args) => {
    const raw = (await container.rest.get(Routes.channelWebhooks(args.channel_id))) as RawWebhook[];
    const wh = raw.map((w) => ({
      id: w.id,
      name: w.name,
      type: w.type,
      channel_id: w.channel_id,
      application_id: w.application_id,
    }));
    const lines = wh.map(
      (w) =>
        `- ${w.name !== null ? wrapUntrusted(w.name, 'webhook') : '_(unnamed)_'} (\`webhook:${w.id}\`, type ${w.type})`,
    );
    return dualResult({
      text: `**${wh.length} webhook(s)**:\n${lines.join('\n')}`,
      data: { webhooks: wh, count: wh.length },
    });
  },
});
