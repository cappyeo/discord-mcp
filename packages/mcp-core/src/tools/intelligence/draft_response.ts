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

interface DraftOutput {
  draft: string;
  reasoning: string;
}

export default defineTool({
  name: 'intelligence_draft_response',
  category: 'intelligence',
  description:
    "**Purpose**: Draft a reply to a Discord channel using the client's LLM. Returns a SUGGESTED draft for human review — does NOT auto-post.\n\n**When to use**: prepare a moderator response, suggest replies for staff, draft outreach.\n\n**Returns**: `{draft, reasoning, sampling_used}`. The agent decides whether to actually call `messages_send` after review.",
  inputSchema: {
    channel_id: ChannelId.describe('Channel for context'),
    context_message_count: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(10)
      .describe('Recent messages to read for context (1-50)'),
    intent: z.string().min(5).max(500).describe('What the response should accomplish'),
    tone: z.enum(['friendly', 'formal', 'concise', 'detailed']).default('friendly'),
  },
  // Analysed fields are optional: without the client `sampling` capability the
  // tool returns the raw payload plus `_meta` instead. See FallbackMeta.
  outputSchema: {
    draft: z.string().optional(),
    reasoning: z.string().optional(),
    sampling_used: z.boolean().optional(),
    raw_context: RawMessagePayload.optional(),
    intent: z.string().optional(),
    tone: z.string().optional(),
    channel_id: z.string().optional(),
    _meta: FallbackMeta,
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  handler: async (args, ctx) => {
    const c = ctx as RunCtxWithSampling;
    const raw = (await container.rest.get(Routes.channelMessages(args.channel_id), {
      query: new URLSearchParams({ limit: String(args.context_message_count) }),
    })) as RawDiscordMessage[];

    if (!c.samplingSupported) {
      const data = fallbackData(
        {
          raw_context: raw.map((m) => ({
            id: m.id,
            author: m.author.global_name ?? m.author.username,
            content: m.content,
          })),
          intent: args.intent,
          tone: args.tone,
          channel_id: args.channel_id,
        },
        'draft_response',
      );
      return dualResult({
        text: '[sampling unavailable — host LLM should draft from raw_context + intent + tone]',
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
        'You are a Discord moderator drafting a reply. Match the requested tone exactly. Do NOT send the reply — output strict JSON {"draft": "...", "reasoning": "..."} for human review.',
      userPrompt: `Tone: ${args.tone}. Intent: ${args.intent}.`,
      untrustedContent: wrapped,
    });

    const sampled = await c.requestSampling({
      messages,
      maxTokens: 600,
      modelPreferences: { intelligencePriority: 0.8, hints: [{ name: 'claude-3-5-sonnet' }] },
    });
    const parsed = parseLLMJsonResponse<DraftOutput>(sampled.content.text);

    if (parsed.ok) {
      return dualResult({
        text: `**Draft (for review)**:\n\n${parsed.data.draft}\n\n_Reasoning_: ${parsed.data.reasoning}`,
        data: {
          draft: parsed.data.draft,
          reasoning: parsed.data.reasoning,
          sampling_used: true,
        },
      });
    }
    return dualResult({
      text: `**Draft (for review)**:\n\n${parsed.raw}`,
      data: { draft: parsed.raw, reasoning: '', sampling_used: true },
    });
  },
});
