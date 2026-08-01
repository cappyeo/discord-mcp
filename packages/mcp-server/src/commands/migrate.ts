/**
 * `discord-mcp migrate` - Plan 9 Phase E + Plan 11 Phase A `--list`.
 *
 * Drives the {@link MigrationSource} registry: pick an adapter via
 * `--from`, detect it against `--source` (or cwd), and emit the
 * resulting {@link MigrationResult} via the shared {@link emitResult}
 * surface. The `--list` flag (Plan 11 Phase A) emits the registry as
 * an informational query with exit code 0, separate from the legacy
 * "no `--from` → list and exit 2" error path which is preserved for
 * backwards compatibility.
 *
 * Exit code policy (per plan §E.6 + Plan 11 §A.3):
 *   - `0` - adapter ran AND every source tool was mapped (i.e.
 *     unmappedTools.length === 0 && manualReview.length === 0). Also
 *     `--list` (informational query - always exit 0).
 *   - `1` - adapter ran but produced unmapped or manual-review items.
 *     This is a "successful run with work left" - the user is told to
 *     hand-edit the output, not that the migration failed.
 *   - `2` - couldn't run at all: missing/unknown `--from`, source not
 *     detected, IO failures inside the adapter.
 *
 * The command never imports adapter implementations directly; it only
 * reads {@link ALL_ADAPTERS}. New sources land via Plan 11 by adding
 * entries to the registry.
 */

import type { MigrationSource } from '../lib/migrate-adapters/index.js';
import { ALL_ADAPTERS } from '../lib/migrate-adapters/index.js';
import { emitResult } from '../lib/output.js';

export interface MigrateOptions {
  from?: string;
  source?: string;
  json?: boolean;
  list?: boolean;
}

/**
 * Render the registry as the human-readable adapter listing emitted by
 * `--list`. Each entry takes two lines: a header `id  description` and
 * a metadata line with languages, tool count estimate, and homepage.
 * Empty / undefined fields are omitted from the metadata line so the
 * output stays clean for adapters that don't fill them in yet.
 */
function renderAdapterListDetails(adapters: readonly MigrationSource[]): string[] {
  const lines: string[] = ['Available migration adapters:', ''];
  // Indent for both header + metadata lines.
  const indent = '  ';
  // Width chosen so the short ids ('hubdustry-go-mcp' = 16 chars) align
  // cleanly with future longer ids without re-wrapping every release.
  const idColumn = 20;

  for (const a of adapters) {
    const idPadded = a.id.padEnd(idColumn, ' ');
    lines.push(`${indent}${idPadded}${a.description}`);

    const metaParts: string[] = [`Languages: ${a.languages.join(', ')}`];
    if (a.toolCountEstimate !== undefined) {
      metaParts.push(`Tools: ~${a.toolCountEstimate}`);
    }
    if (a.homepage !== undefined) {
      metaParts.push(a.homepage);
    }
    lines.push(`${indent}${' '.repeat(idColumn)}${metaParts.join('  ')}`);
    lines.push('');
  }

  lines.push('Use: discord-mcp migrate --from <id> --source <path>');
  return lines;
}

/**
 * Build the structured `data.adapters` payload echoed in JSON mode.
 * Mirrors the public {@link MigrationSource} metadata but as plain
 * data (no functions) so JSON.stringify produces a usable result.
 */
function adapterSummaries(adapters: readonly MigrationSource[]): {
  id: string;
  description: string;
  homepage: string | undefined;
  languages: readonly string[];
  toolCountEstimate: number | undefined;
}[] {
  return adapters.map((a) => ({
    id: a.id,
    description: a.description,
    homepage: a.homepage,
    languages: a.languages,
    toolCountEstimate: a.toolCountEstimate,
  }));
}

/**
 * Emit the full adapter listing as a successful informational query
 * (exit code 0). Shared by the explicit `--list` flag and the legacy
 * "no flags at all" path.
 */
function emitAdapterList(asJson: boolean): void {
  emitResult(
    {
      ok: true,
      exitCode: 0,
      summary: `${ALL_ADAPTERS.length} migration adapter(s) available`,
      data: { adapters: adapterSummaries(ALL_ADAPTERS) },
      details: renderAdapterListDetails(ALL_ADAPTERS),
    },
    asJson,
  );
}

export async function migrateAction(opts: MigrateOptions = {}): Promise<void> {
  const asJson = opts.json === true;

  // 1a. Explicit `--list` flag (Plan 11 Phase A): always exit 0 with
  //     the full adapter listing - this is an informational query, not
  //     an error.
  if (opts.list === true) {
    emitAdapterList(asJson);
    return;
  }

  // 1b. Plan 9 backwards-compat: no `--from` and no `--list` → emit
  //     the legacy "missing --from" error with exit code 2. Plan 11
  //     surfaces the same listing under `--list` (exit 0) but keeps
  //     this branch unchanged so existing scripts that grep stderr or
  //     rely on the non-zero exit signal don't break.
  if (opts.from === undefined) {
    emitResult(
      {
        ok: false,
        exitCode: 2,
        summary: '--from <adapter-id> required',
        data: {
          available: ALL_ADAPTERS.map((a) => ({
            id: a.id,
            description: a.description,
          })),
          adapters: adapterSummaries(ALL_ADAPTERS),
        },
        details: [
          'Available adapters:',
          ...ALL_ADAPTERS.map((a) => `  ${a.id} - ${a.description}`),
          '',
          'Run `discord-mcp migrate --list` for full metadata.',
        ],
        errors: ['use --from with one of the IDs above'],
      },
      asJson,
    );
    return;
  }

  // 2. Resolve the adapter. Unknown id → exit 2 with the available list.
  const adapter = ALL_ADAPTERS.find((a) => a.id === opts.from);
  if (adapter === undefined) {
    emitResult(
      {
        ok: false,
        exitCode: 2,
        summary: `unknown adapter: ${opts.from}`,
        data: {
          requested: opts.from,
          available: ALL_ADAPTERS.map((a) => a.id),
        },
        errors: [`use --from with one of: ${ALL_ADAPTERS.map((a) => a.id).join(', ')}`],
      },
      asJson,
    );
    return;
  }

  // 3. Resolve the source path (default to cwd) and run detect().
  //    `detect` MUST NOT throw per the adapter contract, so we don't
  //    wrap this - any throw is an honest internal bug worth surfacing.
  const sourcePath = opts.source ?? process.cwd();
  if (!(await adapter.detect(sourcePath))) {
    emitResult(
      {
        ok: false,
        exitCode: 2,
        summary: `source not detected at ${sourcePath}`,
        data: { adapter: adapter.id, sourcePath },
        errors: [
          `adapter ${adapter.id} did not match the source - check --source path`,
          `looked for adapter-specific markers in ${sourcePath}`,
        ],
      },
      asJson,
    );
    return;
  }

  // 4. Run the adapter and report the result.
  const result = await adapter.migrate(sourcePath);
  const total =
    result.mappedTools.length + result.unmappedTools.length + result.manualReview.length;

  // Exit code: 0 only when every tool mapped cleanly. Unmapped or manual
  // review still counts as "ran successfully with work left" → exit 1.
  const exitCode: 0 | 1 | 2 =
    result.unmappedTools.length === 0 && result.manualReview.length === 0 ? 0 : 1;

  emitResult(
    {
      ok: exitCode === 0,
      exitCode,
      summary: `${result.mappedTools.length}/${total} mapped, ${result.unmappedTools.length} unmapped, ${result.manualReview.length} manual review`,
      data: { result },
      details: [
        `Adapter: ${result.source}`,
        `Source path: ${result.sourcePath}`,
        `Mapped (${result.mappedTools.length}):`,
        ...result.mappedTools.map((m) => `  ${m.original} → ${m.mapped} [${m.confidence}]`),
        `Unmapped (${result.unmappedTools.length}):`,
        ...result.unmappedTools.map((u) => `  ${u}`),
        `Manual review (${result.manualReview.length}):`,
        ...result.manualReview.map((m) => `  ${m.original}: ${m.reason}`),
      ],
      warnings: [...result.warnings],
    },
    asJson,
  );
}
