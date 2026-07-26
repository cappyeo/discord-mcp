import { container } from '@sapphire/pieces';
import { Routes } from 'discord-api-types/v10';
import { z } from 'zod';
import { defineTool } from '../_lib/defineTool.js';
import { dualResult } from '../_lib/response.js';
import { ChannelId } from '../_lib/snowflake.js';
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

interface SummarizeOutput {
  summary: string;
  key_topics: string[];
  action_items: string[];
}

export default defineTool({
  name: 'intelligence_summarize_channel',
  category: 'intelligence',
  description:
    '**Purpose**: Summarize recent messages in a Discord channel using the client\'s LLM (MCP sampling).\n\n**When to use**: "what was discussed in #X?", "catch me up", "TL;DR".\n\n**Returns**: `{summary, key_topics, action_items, message_count_used, sampling_used}`. Server ships ZERO API keys — uses your client\'s model.\n\n**Fallback**: when client lacks sampling support (Claude Desktop, Cursor, ChatGPT, Cline, Continue, Windsurf), returns raw messages + `_meta.fallback: "host_llm_should_process"` so the host LLM can summarize locally.',
  inputSchema: {
    channel_id: ChannelId.describe('Channel to summarize'),
    limit: z
      .number()
      .int()
      .min(10)
      .max(100)
      .default(50)
      .describe('Messages to consider (10-100, default 50)'),
    style: z.enum(['bullet', 'paragraph', 'executive']).default('bullet').describe('Summary style'),
  },
  // Analysed fields are optional: without the client `sampling` capability the
  // tool returns the raw payload plus `_meta` instead. See FallbackMeta.
  outputSchema: {
    summary: z.string().optional(),
    key_topics: z.array(z.string()).optional(),
    action_items: z.array(z.string()).optional(),
    message_count_used: z.number(),
    sampling_used: z.boolean().optional(),
    raw_messages: RawMessagePayload.optional(),
    channel_id: z.string().optional(),
    style: z.string().optional(),
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
          message_count_used: raw.length,
          channel_id: args.channel_id,
          style: args.style,
        },
        'summarize',
      );
      return dualResult({
        text: '[sampling unavailable — host LLM should summarize from raw_messages]',
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
      systemPrompt:
        'You are a concise Discord-channel summarizer. Output strict JSON with keys: summary (string), key_topics (string[]), action_items (string[]).',
      userPrompt: `Summarize the discussion in ${args.style} style. ${
        args.style === 'bullet'
          ? 'Use 3-5 bullet points.'
          : args.style === 'executive'
            ? 'Single paragraph, business-focused.'
            : 'Single paragraph, conversational.'
      }`,
      untrustedContent: wrapped,
    });

    const sampled = await c.requestSampling({
      messages,
      maxTokens: 800,
      modelPreferences: { intelligencePriority: 0.8, hints: [{ name: 'claude-3-5-sonnet' }] },
    });
    const parsed = parseLLMJsonResponse<SummarizeOutput>(sampled.content.text);

    if (parsed.ok) {
      return dualResult({
        text: parsed.data.summary,
        data: {
          summary: parsed.data.summary,
          key_topics: parsed.data.key_topics,
          action_items: parsed.data.action_items,
          message_count_used: raw.length,
          sampling_used: true,
        },
      });
    }
    // Malformed — return raw text as summary, mark sampling_used: true with empty arrays.
    return dualResult({
      text: parsed.raw,
      data: {
        summary: parsed.raw,
        key_topics: [] as string[],
        action_items: [] as string[],
        message_count_used: raw.length,
        sampling_used: true,
      },
    });
  },
});
