import { container } from '@sapphire/pieces';
import { Routes } from 'discord-api-types/v10';
import { z } from 'zod';
import { CHANNEL_WRITE_WITH_ATTACHMENTS_ACCESS } from '../../access/requirements.js';
import { ValidationError } from '../../errors/client.js';
import {
  rethrowAttachFilesDenied,
  toMessageAttachments,
  UploadedAttachments,
} from '../_lib/attachments.js';
import { withAttributionComponents } from '../_lib/attribution.js';
import { defineTool } from '../_lib/defineTool.js';
import { messageJumpUrl } from '../_lib/message-jump-url.js';
import { dualResult } from '../_lib/response.js';
import { ChannelId, MessageId } from '../_lib/snowflake.js';
import { validateComponentsV2 } from './_lib/validator.js';

const IS_COMPONENTS_V2 = 1 << 15;

interface SentMessage {
  id: string;
  channel_id: string;
  flags?: number;
  guild_id?: string;
}

export default defineTool({
  name: 'components_v2_send',
  category: 'components_v2',
  access: CHANNEL_WRITE_WITH_ATTACHMENTS_ACCESS,
  description:
    '**Purpose**: Send a Components V2 message - rich layout (Container, Section, MediaGallery, ActionRow, ...). MUTUALLY EXCLUSIVE with content/embed/poll/sticker. Flag `IS_COMPONENTS_V2` is irreversible per-message.\n\n**When to use**: announcements, release notes, dashboards, polls - anything beyond plain text.\n\n**When NOT to use**: simple text reply → use `messages_send`.\n\n**Files**: a MediaGallery item can show an uploaded file as `media.url: "attachment://<filename>"`. Upload it first with `attachments_prepare_upload` + an HTTP PUT, then pass `attachments:[{id, filename, uploaded_filename}]` here.\n\n**Validation**: components are validated via `validateComponentsV2` before sending; the call rejects with VALIDATION_FAILED if the layout is illegal (no API call made).\n\n**Returns**: `{message_id, channel_id, jump_url, component_count}`. The server first returns a bounded component review with `payload_hash` and one-time `approval_id`; run with `MCP_DRY_RUN=false`, `__confirm:true`, the exact `__confirm_hash`, and `__confirm_id` before expiry to send once.',
  inputSchema: {
    channel_id: ChannelId.describe('Target channel'),
    components: z
      .array(z.unknown())
      .min(1)
      .max(40)
      .describe('Components V2 array (1-40 items, recursive)'),
    allowed_mentions: z
      .object({
        parse: z.array(z.enum(['users', 'roles', 'everyone'])).optional(),
        users: z.array(z.string()).optional(),
        roles: z.array(z.string()).optional(),
      })
      .optional(),
    attachments: UploadedAttachments,
  },
  outputSchema: {
    message_id: MessageId,
    channel_id: ChannelId,
    jump_url: z.string().url(),
    component_count: z.number().int(),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  confirmation: 'payload_hash' as const,
  handler: async (args, ctx) => {
    // A V2 message has no content field, so the credit becomes a text block.
    const components = withAttributionComponents(args.components, ctx.caller, 'Sent');
    const validation = validateComponentsV2(components);
    if (!validation.valid) {
      throw new ValidationError(
        validation.issues.map((i) => ({ path: i.path, message: i.message, code: i.code })),
      );
    }
    const body: Record<string, unknown> = {
      flags: IS_COMPONENTS_V2,
      components,
    };
    if (args.allowed_mentions !== undefined) body.allowed_mentions = args.allowed_mentions;
    const hasAttachments = args.attachments !== undefined && args.attachments.length > 0;
    if (args.attachments !== undefined && hasAttachments) {
      body.attachments = toMessageAttachments(args.attachments);
    }
    let m: SentMessage;
    try {
      m = (await container.rest.post(Routes.channelMessages(args.channel_id), {
        body,
      })) as SentMessage;
    } catch (error) {
      if (hasAttachments) rethrowAttachFilesDenied(error, args.channel_id);
      throw error;
    }
    return dualResult({
      text: `Sent V2 message ${m.id} to <#${m.channel_id}> (${components.length} top-level components).`,
      data: {
        message_id: m.id,
        channel_id: m.channel_id,
        jump_url: await messageJumpUrl(m),
        component_count: components.length,
      },
    });
  },
});
