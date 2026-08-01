import { container } from '@sapphire/pieces';
import { Routes } from 'discord-api-types/v10';
import { z } from 'zod';
import { defineTool } from '../_lib/defineTool.js';
import { dualResult } from '../_lib/response.js';
import { ChannelId, WebhookId } from '../_lib/snowflake.js';

interface RawFollowedChannel {
  channel_id: string;
  webhook_id: string;
}

export default defineTool({
  name: 'channels_follow_announcement',
  category: 'channels',
  description: [
    '**Purpose**: Cross-post messages from an announcement (news) channel into a target channel via a webhook.',
    '',
    '**When to use**:',
    '- Mirror release announcements from a partner server into your own.',
    '',
    '**When NOT to use**:',
    '- Source channel is not type 5 (GUILD_ANNOUNCEMENT) - Discord rejects.',
    '',
    '**Returns**: `{channel_id, webhook_id}` (webhook_id is the auto-created delivery webhook on the target).',
  ].join('\n'),
  inputSchema: {
    channel_id: ChannelId.describe('Source announcement channel (the one to follow)'),
    webhook_channel_id: ChannelId.describe('Target channel that receives the cross-posts'),
    audit_reason: z
      .string()
      .min(1)
      .max(512)
      .optional()
      .describe('Reason recorded in audit log (X-Audit-Log-Reason header)'),
  },
  outputSchema: {
    channel_id: ChannelId,
    webhook_id: WebhookId,
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  handler: async (args) => {
    const r = (await container.rest.post(Routes.channelFollowers(args.channel_id), {
      body: { webhook_channel_id: args.webhook_channel_id },
      reason: args.audit_reason,
    })) as RawFollowedChannel;
    return dualResult({
      text: `Following announcement <#${args.channel_id}> → <#${args.webhook_channel_id}> (webhook \`${r.webhook_id}\`).`,
      data: { channel_id: r.channel_id, webhook_id: r.webhook_id },
    });
  },
});
