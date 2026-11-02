import { z } from 'zod';

export const snowflake = z.string().regex(/^\d{17,20}$/);
export const filters = z.strictObject({ author_id: snowflake });
export const mentionFilters = z.strictObject({ guild_id: snowflake });
const delivery = z.strictObject({
  mode: z.literal('webhook'),
  url: z.string().max(2048),
  secret: z.string().max(128),
});
const lifetime = {
  ttlMs: z.number().int().positive().nullable().optional(),
  cursor: z.null().optional(),
};
export const subscription = z.discriminatedUnion('name', [
  z.object({ name: z.literal('message.created'), arguments: filters, delivery, ...lifetime }),
  z.object({
    name: z.literal('message.mentioned'),
    arguments: mentionFilters,
    delivery,
    ...lifetime,
  }),
]);
const stopDelivery = delivery.omit({ secret: true });
export const unsubscribe = z.discriminatedUnion('name', [
  z.object({ name: z.literal('message.created'), arguments: filters, delivery: stopDelivery }),
  z.object({
    name: z.literal('message.mentioned'),
    arguments: mentionFilters,
    delivery: stopDelivery,
  }),
]);
export type SubscriptionIdentity = Pick<z.infer<typeof subscription>, 'name' | 'arguments'> & {
  delivery: { url: string };
};
export const payload = z.strictObject({
  message_id: snowflake,
  channel_id: snowflake,
  author_id: snowflake,
  timestamp: z.iso.datetime({ offset: true }),
  text: z.string().min(1).max(4000),
  reply_reference: z.strictObject({ message_id: snowflake, channel_id: snowflake }).nullable(),
});
export const mentionPayload = payload.extend({ guild_id: snowflake, mentioned_bot_id: snowflake });
export type MessageEvent = {
  name: 'message.created' | 'message.mentioned';
  data: z.infer<typeof payload> & { guild_id?: string; mentioned_bot_id?: string };
};
// Guild channel types with text message streams, including voice-channel text chats
// and accessible public/private/announcement threads (forum posts are threads).
export const guildMessageTypes = [0, 2, 5, 10, 11, 12, 13];
export function directlyMentions(
  content: string,
  mentionedUserIds: string[],
  botId: string,
): boolean {
  return mentionedUserIds.includes(botId) && new RegExp(`<@!?${botId}>`).test(content);
}
export const reply = z.strictObject({ event_id: z.string(), content: z.string().min(1).max(2000) });
export const context = z.strictObject({
  event_id: z.string(),
  limit: z.number().int().min(1).max(30).default(20),
});
export function eventDefinition(authorId: string) {
  return {
    name: 'message.created',
    description:
      'A plain-text direct message to this bot from the one operator-authorized Discord account. Retrieve bounded history with events_dm_context and reply with events_dm_reply using event_id. No replay after listener downtime.',
    delivery: ['webhook'],
    inputSchema: z.toJSONSchema(filters.extend({ author_id: z.literal(authorId) })),
    payloadSchema: z.toJSONSchema(payload),
  };
}
export function mentionDefinition(guildId: string, botId: string) {
  return {
    name: 'message.mentioned',
    description:
      "A human directly @mentions this bot in the configured Discord guild, in any accessible channel or thread with a text message stream. Read only bounded context from that conversation with events_message_context, then reply there with events_message_reply using event_id. This is a shared-server request: it does not grant the sender access to the operator's private data or authority over private tools. Bots, webhooks, role/everyone tags and unmentioned messages do not trigger this event. No replay after listener downtime.",
    delivery: ['webhook'],
    inputSchema: z.toJSONSchema(mentionFilters.extend({ guild_id: z.literal(guildId) })),
    payloadSchema: z.toJSONSchema(
      mentionPayload.extend({
        guild_id: z.literal(guildId),
        mentioned_bot_id: z.literal(botId),
      }),
    ),
  };
}
export interface EventBridge {
  call(method: string, params: unknown): Promise<Record<string, unknown>>;
}

export const EVENT_TOOL_NAMES: ReadonlySet<string> = new Set([
  'events_dm_context',
  'events_dm_reply',
  'events_message_context',
  'events_message_reply',
]);
