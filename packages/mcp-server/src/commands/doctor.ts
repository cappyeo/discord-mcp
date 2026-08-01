/**
 * `discord-mcp doctor` — Plan 9 Phase B.
 *
 * Replaces the Phase A placeholder. Iterates the registered offline
 * checks (Phase C will add online ones) and aggregates their results
 * into a single CommandResult.
 *
 * Exit code mapping (per emitResult contract):
 *   - 0 → all checks ok
 *   - 1 → at least one warn, no fails
 *   - 2 → at least one fail
 *
 * `--online` flag is wired but only filters checks (online-tagged ones
 * are skipped when false). The actual online checks are introduced in
 * Phase C — for now the flag is a no-op gating mechanism, kept here so
 * Phase A's option shape stays stable.
 *
 * Config parse: we attempt `loadConfig(process.env)` once and pass the
 * resolved `Config | null` to each check's `run()`. Checks that need
 * raw env (e.g. token-format) read `process.env` directly so they
 * still report meaningful results when Config rejected the env. The
 * `env-vars` check is the canonical reporter for the parse failure
 * itself (status=fail with zod issue details).
 */
import { type Config, loadConfig } from '@discord-mcp/core';
import { ALL_CHECKS, type CheckResult } from '../lib/checks/index.js';
import { emitResult } from '../lib/output.js';

export interface DoctorOptions {
  json?: boolean;
  online?: boolean;
}

export async function doctorAction(opts: DoctorOptions): Promise<void> {
  // Filter: when --online is omitted/false, run only offline checks.
  // When --online is true, run everything (offline + online).
  const checks = ALL_CHECKS.filter((c) => opts.online === true || c.online === false);

  let cfg: Config | null = null;
  try {
    cfg = loadConfig(process.env);
  } catch {
    // env-vars check is the canonical reporter — leave cfg as null and
    // let each check decide what to do (most fall back to raw env).
    cfg = null;
  }

  const results: CheckResult[] = [];
  for (const check of checks) {
    try {
      results.push(await check.run(cfg));
    } catch (e) {
      // Defensive: a check throwing is a bug, not user error. Surface it
      // as a fail so the run is reproducible from the JSON output.
      results.push({
        id: check.id,
        status: 'fail',
        message: `check threw: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }

  const fails = results.filter((r) => r.status === 'fail').length;
  const warns = results.filter((r) => r.status === 'warn').length;
  const oks = results.length - fails - warns;
  const exitCode: 0 | 1 | 2 = fails > 0 ? 2 : warns > 0 ? 1 : 0;

  // Pretty-mode detail lines: one bullet per check with status + id +
  // first-line of message. JSON consumers see the full structured array
  // under `data.checks`.
  const detailLines = results.map((r) => {
    const tag = r.status === 'ok' ? 'OK  ' : r.status === 'warn' ? 'WARN' : 'FAIL';
    return `[${tag}] ${r.id}: ${r.message}`;
  });

  emitResult(
    {
      ok: fails === 0,
      exitCode,
      summary: `${results.length} checks: ${fails} fail, ${warns} warn, ${oks} ok`,
      details: detailLines,
      warnings: results.filter((r) => r.status === 'warn').map((r) => `[${r.id}] ${r.message}`),
      errors: results.filter((r) => r.status === 'fail').map((r) => `[${r.id}] ${r.message}`),
      data: { checks: results as unknown as Record<string, unknown>[] },
    },
    opts.json === true,
  );
}
