import { type APIAttachment, type APIEmbed, ComponentType } from 'discord-api-types/v10';
import { z } from 'zod';
import { ChannelId, MessageId, UserId } from '../../_lib/snowflake.js';

// Keep rich objects open so new Discord fields and component types survive parsing.
const Component = z.looseObject({ type: z.number().int() });
const RichObject = z.looseObject({});

export const messageFields = {
  author_id: UserId,
  author_name: z.string(),
  author_bot: z.boolean(),
  webhook_id: UserId.optional(),
  edited_timestamp: z.string().nullable().optional(),
  message_reference: z
    .looseObject({
      message_id: MessageId.optional(),
      channel_id: ChannelId.optional(),
      guild_id: z.string().optional(),
      type: z.number().optional(),
    })
    .optional(),
  referenced_author_id: UserId.optional(),
  referenced_message_state: z.enum(['present', 'deleted', 'unknown']).optional(),
  started_thread_id: ChannelId.optional(),
  reactions: z.array(RichObject).optional(),
  content: z
    .string()
    .describe('Original Discord content; may be empty for component-only messages'),
  components: z.array(Component).optional().describe('Complete raw Discord component tree'),
  embeds: z.array(RichObject).optional().describe('Complete raw Discord embeds'),
  attachments: z
    .array(RichObject)
    .optional()
    .describe('Raw attachment metadata; URLs are not fetched'),
  flags: z.number().int().optional().describe('Original Discord message flags, when supplied'),
  timestamp: z.string(),
  edited: z.boolean(),
};

export interface RawMessage {
  id: string;
  channel_id: string;
  content: string;
  author: { id: string; username: string; global_name?: string | null; bot?: boolean };
  webhook_id?: string;
  message_reference?: {
    message_id?: string;
    channel_id?: string;
    guild_id?: string;
    type?: number;
  };
  referenced_message?: { author?: { id: string } } | null;
  thread?: { id: string };
  reactions?: Record<string, unknown>[];
  timestamp: string;
  edited_timestamp: string | null;
  pinned?: boolean;
  components?: z.infer<typeof Component>[];
  embeds?: APIEmbed[];
  attachments?: APIAttachment[];
  flags?: number;
}

export function projectMessage(m: RawMessage) {
  return {
    author_id: m.author.id,
    author_name: m.author.global_name ?? m.author.username,
    author_bot: m.author.bot ?? false,
    ...(m.webhook_id === undefined ? {} : { webhook_id: m.webhook_id }),
    ...(m.edited_timestamp === undefined ? {} : { edited_timestamp: m.edited_timestamp }),
    ...(m.message_reference === undefined
      ? {}
      : {
          message_reference: m.message_reference,
          referenced_message_state:
            m.referenced_message === undefined
              ? ('unknown' as const)
              : m.referenced_message === null
                ? ('deleted' as const)
                : ('present' as const),
        }),
    ...(m.referenced_message?.author?.id === undefined
      ? {}
      : { referenced_author_id: m.referenced_message.author.id }),
    ...(m.thread === undefined ? {} : { started_thread_id: m.thread.id }),
    ...(m.reactions === undefined ? {} : { reactions: m.reactions }),
    content: m.content,
    ...(m.components === undefined ? {} : { components: m.components }),
    ...(m.embeds === undefined ? {} : { embeds: m.embeds }),
    ...(m.attachments === undefined ? {} : { attachments: m.attachments }),
    ...(m.flags === undefined ? {} : { flags: m.flags }),
    timestamp: m.timestamp,
    edited: typeof m.edited_timestamp === 'string',
  };
}

/** Derived text for wrapMessages only; never replaces raw structured content. */
export function readableMessageContent(m: RawMessage): string {
  const parts = [m.content];
  function visit(value: unknown): void {
    if (value === null || typeof value !== 'object') return;
    const component = value as Record<string, unknown>;
    if (component.type === ComponentType.TextDisplay && typeof component.content === 'string') {
      parts.push(component.content);
    }
    if (Array.isArray(component.components)) {
      for (const child of component.components) visit(child);
    }
  }
  for (const component of m.components ?? []) visit(component);
  for (const embed of m.embeds ?? []) {
    parts.push(embed.author?.name ?? '', embed.title ?? '', embed.description ?? '');
    for (const field of embed.fields ?? []) parts.push(field.name, field.value);
    parts.push(embed.footer?.text ?? '');
  }
  return parts.filter((part) => part.length > 0).join('\n');
}
