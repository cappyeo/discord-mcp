import { container } from '@sapphire/pieces';
import { Routes } from 'discord-api-types/v10';
import { z } from 'zod';
import { defineTool } from '../_lib/defineTool.js';
import { dualResult } from '../_lib/response.js';
import { ChannelId, MessageId } from '../_lib/snowflake.js';
import { wrapMessages } from '../_lib/untrusted.js';
import {
  buildSamplingPrompt,
  FallbackMeta,
  fallbackData,
  parseLLMJsonResponse,
  RawMessagePayload,
  type SamplingMessage,
} from './_lib/sampling.js';

interface RawDiscordMessage {
  id: string;
  content: string;
  author: { id: string; username: string; global_name?: string | null };
}

interface RunCtxWithSampling {
  signal: AbortSignal;
  samplingSupported: boolean;
  requestSampling: (params: {
    messages: SamplingMessage[];
    maxTokens: number;
    modelPreferences?: { intelligencePriority?: number; hints?: Array<{ name: string }> };
  }) => Promise<{ content: { type: 'text'; text: string } }>;
}

interface ExtractedEntity {
  type: string;
  value: string;
  source_message_id?: string;
  context?: string;
}

interface ExtractOutput {
  entities: ExtractedEntity[];
}

const ENTITY_TYPES = [
  'user_mention',
  'channel_ref',
  'date',
  'decision',
  'action_item',
  'url',
  'code_snippet',
] as const;

export default defineTool({
  name: 'intelligence_extract_entities',
  category: 'intelligence',
  description:
    "**Purpose**: Pull structured entities (decisions, action items, dates, mentions, URLs, code) from recent Discord messages using the client's LLM.\n\n**When to use**: post-meeting recap, audit log of decisions, weekly digest builder.\n\n**Returns**: `{entities:[{type, value, source_message_id?, context?}], count, sampling_used}`.",
  inputSchema: {
    channel_id: ChannelId.describe('Channel to scan'),
    limit: z
      .number()
      .int()
      .min(5)
      .max(100)
      .default(50)
      .describe('Messages to scan (5-100, default 50)'),
    entity_types: z
      .array(z.enum(ENTITY_TYPES))
      .min(1)
      .default(['decision', 'action_item'])
      .describe('Entity types to extract'),
  },
  // Analysed fields are optional: without the client `sampling` capability the
  // tool returns the raw payload plus `_meta` instead. See FallbackMeta.
  outputSchema: {
    entities: z
      .array(
        z.object({
          type: z.string(),
          value: z.string(),
          source_message_id: MessageId.optional(),
          context: z.string().optional(),
        }),
      )
      .optional(),
    count: z.number().optional(),
    sampling_used: z.boolean().optional(),
    raw_messages: RawMessagePayload.optional(),
    entity_types: z.array(z.string()).optional(),
    channel_id: z.string().optional(),
    _meta: FallbackMeta,
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  idempotent: true,
  handler: async (args, ctx) => {
    const c = ctx as RunCtxWithSampling;
    const raw = (await container.rest.get(Routes.channelMessages(args.channel_id), {
      query: new URLSearchParams({ limit: String(args.limit) }),
    })) as RawDiscordMessage[];

    if (!c.samplingSupported) {
      const data = fallbackData(
        {
          raw_messages: raw.map((m) => ({
            id: m.id,
            author: m.author.global_name ?? m.author.username,
            content: m.content,
          })),
          entity_types: args.entity_types,
          channel_id: args.channel_id,
        },
        'extract_entities',
      );
      return dualResult({
        text: '[sampling unavailable — host LLM should extract from raw_messages]',
        data,
      });
    }

    const wrapped = wrapMessages(
      raw.map((m) => ({
        id: m.id,
        author: m.author.global_name ?? m.author.username,
        content: m.content,
      })),
      args.channel_id,
    );
    const messages = buildSamplingPrompt({
      systemPrompt: `Extract entities of these types from Discord messages: ${args.entity_types.join(', ')}. For each, output {"type": "<one of the requested types>", "value": "...", "source_message_id": "<msg id if known>", "context": "<short surrounding context>"}. Output strict JSON: {"entities": [...]}.`,
      userPrompt: 'Scan and extract.',
      untrustedContent: wrapped,
    });

    const sampled = await c.requestSampling({
      messages,
      maxTokens: 1500,
      modelPreferences: { intelligencePriority: 0.7, hints: [{ name: 'claude-3-5-sonnet' }] },
    });
    const parsed = parseLLMJsonResponse<ExtractOutput>(sampled.content.text);

    if (parsed.ok) {
      // `source_message_id` is echoed by the LLM from untrusted channel
      // content, not read from a Discord response. Keep the entity but drop an
      // id that is not one we actually fetched, rather than presenting a
      // hallucinated snowflake as a citation the agent can follow.
      const fetched = new Set(raw.map((m) => m.id));
      const entities = parsed.data.entities.map((e) =>
        e.source_message_id !== undefined && !fetched.has(e.source_message_id)
          ? { ...e, source_message_id: undefined }
          : e,
      );
      return dualResult({
        text: `Extracted ${entities.length} entit${entities.length === 1 ? 'y' : 'ies'}.`,
        data: {
          entities,
          count: entities.length,
          sampling_used: true,
        },
      });
    }
    return dualResult({
      text: '[parse error — LLM returned non-JSON]',
      data: {
        entities: [] as ExtractedEntity[],
        count: 0,
        sampling_used: true,
      },
    });
  },
});
