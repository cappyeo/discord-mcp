/**
 * CLI output formatter - pretty TTY mode and JSON mode.
 *
 * Plan 9 Phase A. The output module is shared by every lifecycle or
 * diagnostic sub-command that emits a structured result.
 *
 * Rules (per plan §3.3 / §A.1):
 * - JSON mode is non-negotiable: when `asJson === true` we MUST NOT
 *   emit any ANSI color codes regardless of TTY status. JSON output
 *   has to be parseable by downstream tooling.
 * - Pretty TTY mode uses manual ANSI escapes (zero new deps).
 * - We never call `process.exit()`. Instead we set `process.exitCode`
 *   so Node drains stdout/stderr naturally before exiting. The single
 *   exception (`serve`) is documented in commands/serve.ts.
 */

/**
 * Structured result emitted by a CLI sub-command.
 *
 * `ok`: terminal success/failure (true when exitCode === 0).
 * `summary`: one-line headline rendered first in pretty mode.
 * `details`: optional multi-line context under the summary.
 * `warnings`: non-blocking notices (exitCode 1 when no errors).
 * `errors`: blocking failures (exitCode 2).
 * `data`: arbitrary JSON-shaped payload echoed in JSON mode.
 * `exitCode`: 0 ok, 1 warns, 2 errors. Caller is responsible for
 *   choosing the right code; emitResult only sets `process.exitCode`.
 */
export interface CommandResult {
  ok: boolean;
  summary: string;
  details?: string[];
  warnings?: string[];
  errors?: string[];
  data?: Record<string, unknown>;
  exitCode: 0 | 1 | 2;
}

// CSI introducer = ESC + '['. Written via \x1b so the source stays
// grep-friendly without an embedded control byte. Manual ANSI keeps
// us at zero new runtime deps (no chalk, no picocolors).
const CSI = '\x1b[';
const ANSI = {
  reset: `${CSI}0m`,
  bold: `${CSI}1m`,
  dim: `${CSI}2m`,
  green: `${CSI}32m`,
  yellow: `${CSI}33m`,
  red: `${CSI}31m`,
  cyan: `${CSI}36m`,
} as const;

function supportsColor(): boolean {
  return process.stdout.isTTY === true;
}

function color(code: string, text: string, enabled: boolean): string {
  if (!enabled) {
    return text;
  }
  return `${code}${text}${ANSI.reset}`;
}

function renderPretty(result: CommandResult): string {
  const enabled = supportsColor();
  const lines: string[] = [];

  const symbol = result.ok
    ? color(ANSI.green, 'OK', enabled)
    : result.exitCode === 2
      ? color(ANSI.red, 'FAIL', enabled)
      : color(ANSI.yellow, 'WARN', enabled);
  lines.push(`${color(ANSI.bold, symbol, enabled)} ${result.summary}`);

  if (result.details !== undefined && result.details.length > 0) {
    for (const detail of result.details) {
      lines.push(`  ${color(ANSI.dim, detail, enabled)}`);
    }
  }

  if (result.warnings !== undefined && result.warnings.length > 0) {
    lines.push('');
    lines.push(color(ANSI.yellow, color(ANSI.bold, 'Warnings:', enabled), enabled));
    for (const warning of result.warnings) {
      lines.push(`  ${color(ANSI.yellow, '*', enabled)} ${warning}`);
    }
  }

  if (result.errors !== undefined && result.errors.length > 0) {
    lines.push('');
    lines.push(color(ANSI.red, color(ANSI.bold, 'Errors:', enabled), enabled));
    for (const err of result.errors) {
      lines.push(`  ${color(ANSI.red, '*', enabled)} ${err}`);
    }
  }

  return `${lines.join('\n')}\n`;
}

/**
 * Emit a CommandResult. Sets `process.exitCode = result.exitCode`.
 * Never calls `process.exit()` - Node drains stdout/stderr naturally
 * once the event loop empties.
 */
export function emitResult(result: CommandResult, asJson: boolean): void {
  if (asJson) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(renderPretty(result));
  }
  process.exitCode = result.exitCode;
}
