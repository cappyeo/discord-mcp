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

interface ClassifyOutput {
  classifications: Array<{
    message_id: string;
    author: string;
    category: string;
    confidence: number;
  }>;
}

export default defineTool({
  name: 'intelligence_classify_messages',
  category: 'intelligence',
  description:
    "**Purpose**: Classify recent messages into provided categories using the client's LLM. Each classification carries a 0-1 confidence score.\n\n**When to use**: triage spam vs. question vs. discussion; bucket support requests; segment conversations.\n\n**Returns**: `{classifications:[{message_id, author, category, confidence}], count, sampling_used}`.",
  inputSchema: {
    channel_id: ChannelId.describe('Channel to classify messages from'),
    categories: z
      .array(z.string().min(1).max(50))
      .min(2)
      .max(20)
      .describe('Category labels (2-20)'),
    limit: z
      .number()
      .int()
      .min(5)
      .max(100)
      .default(25)
      .describe('Messages to classify (5-100, default 25)'),
  },
  // Analysed fields are optional: without the client `sampling` capability the
  // tool returns the raw payload plus `_meta` instead. See FallbackMeta.
  outputSchema: {
    classifications: z
      .array(
        z.object({
          message_id: MessageId,
          author: z.string(),
          category: z.string(),
          confidence: z.number().min(0).max(1),
        }),
      )
      .optional(),
    count: z.number().optional(),
    sampling_used: z.boolean().optional(),
    raw_messages: RawMessagePayload.optional(),
    categories: z.array(z.string()).optional(),
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
          categories: args.categories,
          channel_id: args.channel_id,
        },
        'classify',
      );
      return dualResult({
        text: '[sampling unavailable - host LLM should classify from raw_messages + categories]',
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
      systemPrompt: `Classify each Discord message into ONE of these categories: ${args.categories.join(', ')}. Output strict JSON: {"classifications": [{"message_id": "...", "author": "...", "category": "...", "confidence": 0.0-1.0}]}.`,
      userPrompt: 'For each message, choose the best-fitting category and a confidence score.',
      untrustedContent: wrapped,
    });

    const sampled = await c.requestSampling({
      messages,
      maxTokens: 1500,
      modelPreferences: { intelligencePriority: 0.7, hints: [{ name: 'claude-3-5-sonnet' }] },
    });
    const parsed = parseLLMJsonResponse<ClassifyOutput>(sampled.content.text);

    if (parsed.ok) {
      // Reconcile the model's output against the messages we actually fetched.
      // `message_id` here is echoed by the LLM from untrusted channel content,
      // not read from a Discord response - a hallucinated or reformatted id
      // would be handed to the agent as a verified snowflake, and the agent
      // may then act on the wrong message. Anything not in the batch we sent
      // is dropped rather than passed through.
      const fetched = new Set(raw.map((m) => m.id));
      const classifications = parsed.data.classifications.filter((cl) =>
        fetched.has(cl.message_id),
      );
      return dualResult({
        text: `Classified ${classifications.length} message(s).`,
        data: {
          classifications,
          count: classifications.length,
          sampling_used: true,
        },
      });
    }
    return dualResult({
      text: '[parse error - LLM returned non-JSON]',
      data: {
        classifications: [] as ClassifyOutput['classifications'],
        count: 0,
        sampling_used: true,
      },
    });
  },
});
