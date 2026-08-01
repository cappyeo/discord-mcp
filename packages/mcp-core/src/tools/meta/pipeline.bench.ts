import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { bench, describe } from 'vitest';
import { executePipeline, type Step } from '../../pipeline/executor.js';

/**
 * Plan 12 Phase E.1 — performance bench for `mcp_pipeline`.
 *
 * Measures the pipeline executor itself (orchestration overhead +
 * interpolation), with a synthetic `invoke` that returns immediately so
 * we isolate the pipeline cost from underlying tool/REST cost.
 *
 * Run via `pnpm --filter @discord-mcp/core bench`. Numbers are
 * informational; CI does NOT gate on bench p50/p95.
 */

// Synthetic invoke that resolves with a deterministic structuredContent,
// echoing back the input args under a `received` key so interpolation
// has something to chew on.
const invoke = async (
  toolName: string,
  args: unknown,
  _signal: AbortSignal,
): Promise<CallToolResult> => {
  return {
    isError: false,
    content: [{ type: 'text', text: `${toolName} ok` }],
    structuredContent: {
      tool: toolName,
      received: args,
      field: 'value-from-step',
      count: 3,
    },
  };
};

const ctx = { signal: new AbortController().signal };

const oneStep: readonly Step[] = [{ id: 'step1', tool: 'fake_tool_1', args: { input: 'a' } }];

const fiveStepLinear: readonly Step[] = [
  { id: 'step1', tool: 'fake_tool_1', args: { input: 'a' } },
  { id: 'step2', tool: 'fake_tool_2', args: { input: 'b' } },
  { id: 'step3', tool: 'fake_tool_3', args: { input: 'c' } },
  { id: 'step4', tool: 'fake_tool_4', args: { input: 'd' } },
  { id: 'step5', tool: 'fake_tool_5', args: { input: 'e' } },
];

const fiveStepInterpolated: readonly Step[] = [
  { id: 'step1', tool: 'fake_tool_1', args: { input: 'seed' } },
  { id: 'step2', tool: 'fake_tool_2', args: { ref: '{{step1.field}}' } },
  { id: 'step3', tool: 'fake_tool_3', args: { ref: '{{step2.field}}', count: '{{step1.count}}' } },
  { id: 'step4', tool: 'fake_tool_4', args: { ref: '{{step3.field}}' } },
  { id: 'step5', tool: 'fake_tool_5', args: { ref: '{{step4.field}}' } },
];

describe('mcp_pipeline bench', () => {
  bench(
    'pipeline 1-step (baseline)',
    async () => {
      await executePipeline(oneStep, invoke, ctx);
    },
    { iterations: 100 },
  );

  bench(
    'pipeline 5-step linear',
    async () => {
      await executePipeline(fiveStepLinear, invoke, ctx);
    },
    { iterations: 100 },
  );

  bench(
    'pipeline 5-step with interpolation {{step1.field}}',
    async () => {
      await executePipeline(fiveStepInterpolated, invoke, ctx);
    },
    { iterations: 100 },
  );
});
