import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { beforeAll, bench, describe } from 'vitest';
import { compose, type MiddlewareContext } from '../../middleware/compose.js';
import { telemetryMiddleware } from '../../middleware/telemetry.js';
import { validateMiddleware } from '../../middleware/validate.js';
import messagesSend from './send.js';
import '../../container.js';

/**
 * Plan 12 Phase E.1 — performance bench for messages_send.
 *
 * Run via `pnpm --filter @discord-mcp/core bench`. Bench files run on
 * `vitest bench` only; they're excluded from `vitest run` because
 * `vitest.config.ts` `include: ['src/** /*.test.ts']` does NOT match `.bench.ts`.
 *
 * Critical: msw patches global fetch via beforeAll() in
 * `mcp-server-mocks/src/setup.ts`. The REST instance must be constructed
 * AFTER msw runs, otherwise `makeRequest: fetch` captures the unpatched
 * built-in fetch and bench iterations hit real Discord (401). The
 * `beforeAll` block below guarantees correct ordering.
 *
 * Numbers are informational; CI does NOT gate on bench p50/p95.
 */

// Concrete instance shape — defineTool returns the abstract Tool typeof, so we
// alias to a structural type that mirrors what `messagesSend` produces.
interface RunnableTool {
  run(args: unknown, ctx: { signal: AbortSignal }): Promise<unknown>;
}

let instance: RunnableTool;
let composed: (ctx: MiddlewareContext) => Promise<unknown>;

const baseArgs = { channel_id: '112233445566778899', content: 'hello world' };
const ttsArgs = { channel_id: '112233445566778899', content: 'hello world', tts: true };

beforeAll(() => {
  // `makeRequest` typing on @discordjs/rest is stricter than the global
  // fetch's, so cast through unknown to satisfy `exactOptionalPropertyTypes`.
  container.rest = new REST({
    version: '10',
    makeRequest: fetch as unknown as REST['options']['makeRequest'],
  }).setToken('fake.test.token-abcdefghijklmnopqrstuvwxyz');
  const ToolCls = messagesSend as unknown as new (
    ctx: { name: string; path: string; root: string; store: never },
    opts: { name: string; enabled: boolean },
  ) => RunnableTool;
  instance = new ToolCls(
    { name: 'messages_send', path: 'memory', root: 'memory', store: null as never },
    { name: 'messages_send', enabled: true },
  );
  const handler = async (ctx: MiddlewareContext) => {
    return instance.run(ctx.args, { signal: new AbortController().signal });
  };
  composed = compose([validateMiddleware(), telemetryMiddleware()], handler);
});

describe('messages_send bench', () => {
  bench(
    'messages_send happy path',
    async () => {
      await instance.run(baseArgs, { signal: new AbortController().signal });
    },
    { iterations: 1000 },
  );

  bench(
    'messages_send with extra field (tts:true)',
    async () => {
      await instance.run(ttsArgs, { signal: new AbortController().signal });
    },
    { iterations: 1000 },
  );

  bench(
    'messages_send via middleware chain (validate + telemetry)',
    async () => {
      const meta = new Map<string, unknown>();
      meta.set('toolPiece', instance);
      await composed({
        tool: { name: 'messages_send', category: 'messages', idempotent: false },
        args: baseArgs,
        meta,
      });
    },
    { iterations: 1000 },
  );
});
