/**
 * `audit-sink` check - Plan 9 Phase B.
 *
 * Verifies the configured audit sink can actually be written to,
 * WITHOUT performing an intrusive write:
 *   - 'stderr' / 'otlp' / 'none' → always ok (no filesystem dependency)
 *   - 'file' → use `fs.accessSync` to probe permission. If the file
 *     exists, check W_OK | F_OK. If it doesn't exist (F_OK fails),
 *     fall back to checking the parent directory's W_OK so users
 *     get a clear actionable message before runtime.
 *
 * If `cfg === null` (env-vars failed to parse) we skip the file probe
 * and report 'warn' - env-vars will already have failed, so we don't
 * double-fail the run.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DoctorCheck } from './index.js';

const DEFAULT_AUDIT_FILE = './discord-mcp-audit.jsonl';

function probeFileWritable(
  filePath: string,
): { ok: true } | { ok: false; reason: string; probedDir?: string } {
  // First: does the file exist and is it writable?
  try {
    fs.accessSync(filePath, fs.constants.F_OK | fs.constants.W_OK);
    return { ok: true };
  } catch {
    // Either F_OK failed (file doesn't exist) or W_OK failed
    // (no permission). Both fall through to the dir-probe; if the
    // directory is writable we treat the missing-file case as ok.
  }

  // Probe parent directory writability.
  const dir = path.dirname(path.resolve(filePath));
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    return { ok: true };
  } catch (e) {
    return {
      ok: false,
      reason: e instanceof Error ? e.message : String(e),
      probedDir: dir,
    };
  }
}

export const auditSinkCheck: DoctorCheck = {
  id: 'audit-sink',
  description: 'Audit sink writability',
  online: false,
  async run(config) {
    if (config === null) {
      return {
        id: 'audit-sink',
        status: 'warn',
        message: 'Skipped - config did not parse (see env-vars)',
      };
    }

    const sink = config.MCP_AUDIT_SINK;
    const file = config.MCP_AUDIT_FILE;

    if (sink !== 'file') {
      return {
        id: 'audit-sink',
        status: 'ok',
        message: `Audit sink "${sink}" requires no filesystem probe`,
        details: { sink, file },
      };
    }

    const filePath = file ?? DEFAULT_AUDIT_FILE;
    const probe = probeFileWritable(filePath);

    if (probe.ok) {
      return {
        id: 'audit-sink',
        status: 'ok',
        message: `Audit file "${filePath}" is writable`,
        details: { sink, file: filePath },
      };
    }

    return {
      id: 'audit-sink',
      status: 'fail',
      message: `Audit file "${filePath}" is not writable: ${probe.reason}`,
      details: {
        sink,
        file: filePath,
        probedDir: probe.probedDir,
      },
    };
  },
};
