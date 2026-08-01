/**
 * Doctor check registry — Plan 9 Phase B.
 *
 * Each check implements the {@link DoctorCheck} interface and is registered
 * in {@link ALL_CHECKS}. The doctor command iterates the array, filters by
 * the `--online` flag, and aggregates {@link CheckResult}s.
 *
 * Phase B shipped 5 offline checks (`online: false`):
 *   - node-version
 *   - token-format
 *   - env-vars
 *   - audit-sink
 *   - client-caps
 *
 * Phase C appends 2 online checks (`online: true`, gated by --online):
 *   - token-online
 *   - otel-reachable
 *
 * The array is intentionally simple `[a, b, c]` so future phases just
 * push more entries.
 */
import type { Config } from '@discord-mcp/core';
import { auditSinkCheck } from './audit-sink.js';
import { clientCapsCheck } from './client-caps.js';
import { envVarsCheck } from './env-vars.js';
import { nodeVersionCheck } from './node-version.js';
import { otelReachableCheck } from './otel-reachable.js';
import { tokenFormatCheck } from './token-format.js';
import { tokenOnlineCheck } from './token-online.js';

/**
 * A single doctor check.
 *
 * `online` distinguishes offline checks (always run) from online ones
 * that hit the network (only run when `--online` is passed).
 *
 * `run()` receives the parsed Config or `null` (if env-vars failed to
 * parse) so each check can decide how to handle a missing config.
 * Most checks read `process.env` directly when they need raw values
 * (e.g. token-format inspects DISCORD_TOKEN even when Config rejected it).
 */
export interface DoctorCheck {
  readonly id: string;
  readonly description: string;
  readonly online: boolean;
  run(config: Config | null): Promise<CheckResult>;
}

/**
 * Result emitted by a single check.
 *
 * `status`:
 *   - 'ok'   → check passed, contributes 0 to exitCode
 *   - 'warn' → non-fatal advisory, contributes 1 (clamped at fail)
 *   - 'fail' → blocking, exitCode = 2
 *
 * `details` may include any redacted, structured payload (NEVER the
 * actual token / secrets). Lengths and flags only.
 */
export interface CheckResult {
  readonly id: string;
  readonly status: 'ok' | 'warn' | 'fail';
  readonly message: string;
  readonly details?: Record<string, unknown>;
}

/**
 * Registered checks in deterministic order. The doctor command preserves
 * this order in its output. Phase C appends online checks to the tail.
 */
export const ALL_CHECKS: readonly DoctorCheck[] = [
  nodeVersionCheck,
  tokenFormatCheck,
  envVarsCheck,
  auditSinkCheck,
  clientCapsCheck,
  tokenOnlineCheck,
  otelReachableCheck,
];
