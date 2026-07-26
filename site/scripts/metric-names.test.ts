/**
 * Drift guard: every `mcp.*` telemetry name the docs put in backticks must be
 * a real convention.
 *
 * The v0.8.0 changelog shipped six invented metric names (`mcp.requests`,
 * `mcp.duration`, `mcp.retries`, …) and the operator telemetry pages shipped
 * label names (`from`, `to`, `route`, `error_code`) that no emit site produces,
 * plus dashboard queries built on them that silently match nothing.
 *
 * The allowed set is the conventions module's own exported values PLUS a short
 * explicit extras list. A naive "every backticked `mcp.*` must be a conventions
 * export" rule fails on CORRECT docs: telemetry.mdx legitimately backticks the
 * span-event name, the redaction attribute, and the templated span name.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as Conventions from '../../packages/mcp-core/src/telemetry/conventions.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(__dirname, '../..');
const DOC_ROOTS = [join(ROOT, 'site/src/content/docs'), join(ROOT, 'docs')];
const EXCLUDED_DIRS = [join(ROOT, 'site/src/content/docs/tools'), join(ROOT, 'docs/superpowers')];

/**
 * Names that are real but are not (and should not be) conventions exports.
 * Keep this list short and justified — every entry is a hole in the guard.
 */
const EXTRAS = new Set<string>([
  // Span event name + its attribute, emitted inline by middleware/telemetry.ts.
  'mcp.tool.args',
  'mcp.args.redacted',
  // Templated span name — `<tool_name>` is a placeholder, not a literal.
  'mcp.tool.<tool_name>',
  'mcp.tool.<name>',
  // Resource attribute set in telemetry/resource.ts, not conventions.ts.
  'mcp.tool_count',
]);

/** Backticked dotted `mcp.*` identifiers. Placeholders in <angle> allowed. */
const MCP_NAME = /`(mcp\.[a-z0-9_.<>]+)`/g;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (
      EXCLUDED_DIRS.some((d) => full === d || full.startsWith(`${d}\\`) || full.startsWith(`${d}/`))
    )
      continue;
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (full.endsWith('.mdx') || full.endsWith('.md')) out.push(full);
  }
  return out;
}

function allowedNames(): Set<string> {
  const allowed = new Set<string>(EXTRAS);
  for (const value of Object.values(Conventions)) {
    if (typeof value === 'string' && value.startsWith('mcp.')) allowed.add(value);
  }
  return allowed;
}

describe('telemetry names in docs match the conventions module', () => {
  it('the conventions module exports the six metric names (guards the guard)', () => {
    const allowed = allowedNames();
    for (const name of [
      'mcp.tool.duration_ms',
      'mcp.tool.calls',
      'mcp.tool.errors',
      'mcp.circuit.transitions',
      'mcp.bulkhead.rejected.count',
      'mcp.deadletter.count',
    ]) {
      expect(allowed.has(name), `${name} must be exported from conventions.ts`).toBe(true);
    }
  });

  it('every backticked mcp.* name in the docs is a real convention', () => {
    const allowed = allowedNames();
    const bad: string[] = [];
    for (const file of DOC_ROOTS.flatMap((d) => walk(d))) {
      const src = readFileSync(file, 'utf8');
      const seen = new Set<string>();
      for (const m of src.matchAll(MCP_NAME)) {
        const name = m[1]!;
        if (seen.has(name) || allowed.has(name)) continue;
        seen.add(name);
        bad.push(`${relative(ROOT, file).replace(/\\/g, '/')}: \`${name}\``);
      }
    }
    expect(bad.sort(), 'docs reference telemetry names that are never emitted').toEqual([]);
  });

  it('resilience metric labels documented are the ones actually emitted', () => {
    // buildPolicy is called once per process and cockatiel's hooks receive no
    // per-call context, so these three counters cannot carry tool/route labels.
    expect(Conventions.ATTR_CIRCUIT_TO_STATE).toBe('to_state');
    expect(Conventions.ATTR_ERROR_TYPE).toBe('error.type');

    for (const file of [
      join(ROOT, 'site/src/content/docs/operations/telemetry.mdx'),
      join(ROOT, 'docs/operations/telemetry.md'),
    ]) {
      const src = readFileSync(file, 'utf8');
      const rel = relative(ROOT, file).replace(/\\/g, '/');
      expect(src.includes('`to_state`'), `${rel} must document the to_state label`).toBe(true);
      // The Prometheus query must use the emitted label, or it matches nothing.
      expect(src, `${rel} has a dashboard query on a non-existent label`).not.toMatch(
        /mcp_circuit_transitions_total\{to=/,
      );
      // Neither resilience counter has a route dimension to group by.
      expect(src, `${rel} groups a resilience query by a non-existent label`).not.toMatch(
        /sum by \(route\)/,
      );
    }
  });
});
