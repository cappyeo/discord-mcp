/**
 * Vitest global setup — Plan 12 Phase C.3.
 *
 * Runs ONCE per `vitest run` invocation (not per test file). Ensures the
 * two `dist/` artefacts that integration tests depend on actually exist:
 *
 *  1. `packages/mcp-core/dist/index.js` — every test that imports from
 *     `@discord-mcp/core` resolves through the workspace symlink to
 *     mcp-core's compiled output. Vitest deps.optimizer can sometimes
 *     run before turbo's dep graph builds it; on a fresh worktree (CI
 *     pull, fresh clone) the dist might be missing.
 *  2. `packages/mcp-server/dist/cli.js` — the `cli.smoke.test.ts`
 *     spawns this binary as a subprocess. Pre-Plan-12 this test
 *     self-skipped via `describe.skipIf(!cliBuilt)`. With this hook in
 *     place we can drop the gate (Plan 12 Phase C.4) so the smoke
 *     coverage runs everywhere, including local dev without a manual
 *     `pnpm build` step.
 *
 * We use `pnpm --filter @discord-mcp/cli build` for the cli build because
 * it transitively rebuilds mcp-core via turbo's `dependsOn: ['^build']`.
 * That single command therefore satisfies BOTH artefacts above.
 *
 * Performance: skipped entirely when both artefacts already exist (the
 * common path during dev). On CI `pnpm build` runs as a separate step
 * before `pnpm test`, so this hook is a defensive no-op there too.
 */
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));

export default async function setup(): Promise<void> {
  const cliDist = resolve(here, 'dist/cli.js');
  const coreDist = resolve(here, '../mcp-core/dist/index.js');

  if (existsSync(cliDist) && existsSync(coreDist)) {
    return;
  }

  // Use `console.warn` so biome's noConsole rule (which allows warn/error)
  // doesn't flag this. It's printed once per `vitest run` and only when
  // the dist artefacts were absent — i.e. fresh worktree / cold CI.
  console.warn(
    '[vitest-global] dist/ artefacts missing — building @discord-mcp/cli (transitively rebuilds @discord-mcp/core)...',
  );
  // workspace root = ../../ relative to packages/mcp-server.
  const workspaceRoot = resolve(here, '../..');
  execSync('pnpm --filter @discord-mcp/cli build', {
    stdio: 'inherit',
    cwd: workspaceRoot,
  });
}
