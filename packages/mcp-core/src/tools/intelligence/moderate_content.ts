import { z } from 'zod';
import { defineTool } from '../_lib/defineTool.js';
import { dualResult } from '../_lib/response.js';
import { wrapUntrusted } from '../_lib/untrusted.js';
import {
  buildSamplingPrompt,
  FallbackMeta,
  fallbackData,
  parseLLMJsonResponse,
  type SamplingMessage,
} from './_lib/sampling.js';

interface RunCtxWithSampling {
  signal: AbortSignal;
  samplingSupported: boolean;
  requestSampling: (params: {
    messages: SamplingMessage[];
    maxTokens: number;
    modelPreferences?: { intelligencePriority?: number; hints?: Array<{ name: string }> };
  }) => Promise<{ content: { type: 'text'; text: string } }>;
}

interface ModerateOutput {
  decision: 'allow' | 'flag' | 'block';
  reasons: string[];
  confidence: number;
}

export default defineTool({
  name: 'intelligence_moderate_content',
  category: 'intelligence',
  description:
    '**Purpose**: Apply a plain-language moderation policy to a piece of text using the client\'s LLM. No Discord API call - purely a moderation utility.\n\n**When to use**: pre-check user-submitted content; second-opinion on AutoMod decisions; classify ambiguous messages.\n\n**Returns**: `{decision: "allow"|"flag"|"block", reasons[], confidence, sampling_used}`.',
  inputSchema: {
    content: z.string().min(1).max(4000).describe('Text to moderate'),
    policy: z
      .string()
      .min(10)
      .max(2000)
      .default('Reject hate speech, doxxing, spam, and explicit content.')
      .describe('Moderation policy in plain language'),
  },
  // Analysed fields are optional: without the client `sampling` capability the
  // tool returns the raw payload plus `_meta` instead. See FallbackMeta.
  outputSchema: {
    decision: z.enum(['allow', 'flag', 'block']).optional(),
    reasons: z.array(z.string()).optional(),
    confidence: z.number().min(0).max(1).optional(),
    sampling_used: z.boolean().optional(),
    content: z.string().optional(),
    policy: z.string().optional(),
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

    if (!c.samplingSupported) {
      const data = fallbackData(
        {
          content: args.content,
          policy: args.policy,
        },
        'moderate',
      );
      return dualResult({
        text: '[sampling unavailable - host LLM should moderate using policy]',
        data,
      });
    }

    const wrapped = wrapUntrusted(args.content, 'message');
    const messages = buildSamplingPrompt({
      systemPrompt:
        'You are a content moderator. Apply the policy strictly. Output strict JSON: {"decision": "allow"|"flag"|"block", "reasons": ["..."], "confidence": 0.0-1.0}.',
      userPrompt: `Policy:\n${args.policy}\n\nEvaluate the content below.`,
      untrustedContent: wrapped,
    });

    const sampled = await c.requestSampling({
      messages,
      maxTokens: 400,
      modelPreferences: { intelligencePriority: 0.7, hints: [{ name: 'claude-3-5-sonnet' }] },
    });
    const parsed = parseLLMJsonResponse<ModerateOutput>(sampled.content.text);

    if (parsed.ok) {
      return dualResult({
        text: `**Moderation: ${parsed.data.decision.toUpperCase()}** (confidence ${parsed.data.confidence.toFixed(2)})\n${parsed.data.reasons.length > 0 ? `\nReasons:\n${parsed.data.reasons.map((r) => `- ${r}`).join('\n')}` : ''}`,
        data: {
          decision: parsed.data.decision,
          reasons: parsed.data.reasons,
          confidence: parsed.data.confidence,
          sampling_used: true,
        },
      });
    }
    return dualResult({
      text: '[parse error - defaulting to flag]',
      data: {
        decision: 'flag' as const,
        reasons: ['LLM returned non-JSON; review manually'],
        confidence: 0.0,
        sampling_used: true,
      },
    });
  },
});
