import { metrics, trace } from '@opentelemetry/api';
import { bench, describe } from 'vitest';
import type { MiddlewareContext } from './compose.js';
import { telemetryMiddleware } from './telemetry.js';

const tool = { name: 'messages_send', category: 'messages', idempotent: false };
const pipelineTool = { name: 'mcp_pipeline', category: 'meta', idempotent: false };
const smallArgs = { channel_id: '111', content: 'hello' };
const deepArgs = {
  steps: Array.from({ length: 20 }, (_, index) => ({
    tool: 'messages_send',
    args: { channel_id: '111', content: `step-${index}` },
  })),
};
const ctx = (args: unknown, currentTool = tool): MiddlewareContext<unknown> => ({
  tool: currentTool,
  args,
  meta: new Map(),
});

trace.disable();
metrics.disable();
const middleware = telemetryMiddleware();

describe('telemetry middleware non-recording span CPU bench', () => {
  bench('small message middleware', async () => {
    await middleware.onCallTool!(ctx(smallArgs), async () => ({ isError: false }));
  });

  bench('20-step pipeline args middleware', async () => {
    await middleware.onCallTool!(ctx(deepArgs, pipelineTool), async () => ({ isError: false }));
  });
});
