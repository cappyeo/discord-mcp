import type { Logger } from 'pino';
import { beforeAll, bench, describe } from 'vitest';
import { loadConfig } from './config.js';
import { type BuildServerDeps, buildServer } from './server.js';

const noop = () => undefined;
const logger = {
  trace: noop,
  debug: noop,
  info: noop,
  warn: noop,
  error: noop,
  fatal: noop,
  child() {
    return this;
  },
} as unknown as Logger;
const config = loadConfig({
  DISCORD_TOKEN: `Bot ${'a'.repeat(60)}`,
  LOG_LEVEL: 'fatal',
  MCP_AUDIT_ENABLED: 'false',
  MCP_TOOL_SURFACE: 'progressive',
  MCP_WRITE_MODE: 'preview',
  OTEL_ENABLED: 'false',
} as NodeJS.ProcessEnv);
const deps = {
  rest: {},
  logger,
  config,
  transport: 'http',
  auditSink: { write: async () => undefined },
} as unknown as BuildServerDeps;

beforeAll(async () => {
  // Exclude one-time registry construction from the per-request benchmark.
  const warm = await buildServer(deps);
  await warm.server.close();
});

describe('stateless HTTP server build bench', () => {
  bench(
    'build from shared registry and close',
    async () => {
      const built = await buildServer(deps);
      await built.server.close();
    },
    { iterations: 1_000 },
  );
});
