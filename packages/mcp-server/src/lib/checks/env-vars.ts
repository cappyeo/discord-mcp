/**
 * `env-vars` check - Plan 9 Phase B.
 *
 * Validates the full Config schema by attempting `loadConfig(process.env)`.
 * On success, status='ok'. On failure we surface the thrown message as a
 * single-issue list so users see exactly which env vars are wrong
 * (without leaking values).
 *
 * We re-parse here even though doctor.ts has already attempted parse -
 * the doctor entry point passes `cfg | null` to checks for re-use, but
 * env-vars is the canonical reporter for parse failures, so we own the
 * full re-parse to capture the failure message.
 */
import { loadConfig } from '@discord-mcp/core';
import type { DoctorCheck } from './index.js';

export const envVarsCheck: DoctorCheck = {
  id: 'env-vars',
  description: 'Config environment variables',
  online: false,
  async run() {
    try {
      loadConfig(process.env);
      return {
        id: 'env-vars',
        status: 'ok',
        message: 'All required environment variables are present and valid',
      };
    } catch (e) {
      // loadConfig never lets the ZodError escape: it formats the issues
      // into `new Error("Invalid configuration:\n  - <path>: <message>")`
      // (see @discord-mcp/core config.ts) and throws that. So there is no
      // structured issues array to unwrap here - the message already
      // lists path + message per issue.
      //
      // loadConfig throws Error with multi-line message like
      // "Invalid configuration:\n  - DISCORD_TOKEN: too short"
      // We surface it as a single-issue list so the JSON shape stays
      // stable for downstream tooling.
      const message = e instanceof Error ? e.message : String(e);
      return {
        id: 'env-vars',
        status: 'fail',
        message: 'Config validation failed',
        details: { errors: [{ path: '', message }] },
      };
    }
  },
};
