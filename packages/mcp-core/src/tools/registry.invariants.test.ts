/**
 * Registry-wide invariants over all 207 tools.
 *
 * These are the checks that per-tool test files structurally cannot make: a
 * tool that forgets its confirm gate, mislabels itself as read-only, or
 * declares a precondition nothing implements passes its own unit test and
 * only shows up here.
 *
 * Loads `__toolMetadata` off each tool class by walking the tools tree and
 * dynamically importing every non-test module - the same mechanism
 * `site/scripts/generate-tool-docs.ts` uses to build the docs, so a tool that
 * is invisible here is also missing from the published reference.
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

interface ToolMeta {
  name: string;
  category: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
  preconditions: readonly string[];
  sourcePath: string;
}

const TOOLS_DIR = fileURLToPath(new URL('.', import.meta.url));

/** Preconditions the server actually registers (server.ts preconditionStore). */
const IMPLEMENTED_PRECONDITIONS = new Set([
  'confirm_required',
  'category_enabled',
  'explicit_guild_required',
]);

let tools: ToolMeta[] = [];

beforeAll(async () => {
  const categories = readdirSync(TOOLS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('_'))
    .map((e) => e.name);

  for (const category of categories) {
    const dir = join(TOOLS_DIR, category);
    const files = readdirSync(dir).filter(
      (f) =>
        f.endsWith('.ts') &&
        !f.endsWith('.test.ts') &&
        !f.endsWith('.bench.ts') &&
        !f.startsWith('_'),
    );
    for (const file of files) {
      const sourcePath = join(dir, file);
      const mod = await import(`file://${sourcePath.replace(/\\/g, '/')}`);
      const meta = (mod.default as { __toolMetadata?: ToolMeta } | undefined)?.__toolMetadata;
      if (meta === undefined) continue;
      tools.push({ ...meta, preconditions: meta.preconditions ?? [], sourcePath });
    }
  }
  tools = tools.sort((a, b) => a.name.localeCompare(b.name));
});

describe('tool registry invariants', () => {
  it('discovers the full advertised tool surface', () => {
    expect(tools.length).toBe(207);
    expect(new Set(tools.map((t) => t.name)).size).toBe(tools.length);
    expect(new Set(tools.map((t) => t.category)).size).toBe(31);
  });

  it('every destructive tool is gated by confirm_required, and vice versa', () => {
    // Both directions matter. A destructive tool without the gate executes
    // irreversible Discord operations on a bare agent call; a gated
    // non-destructive tool trains operators to run with MCP_DRY_RUN=false.
    const destructive = tools
      .filter((t) => t.annotations.destructiveHint === true)
      .map((t) => t.name);
    const gated = tools
      .filter((t) => t.preconditions.includes('confirm_required'))
      .map((t) => t.name);
    expect(destructive.filter((n) => !gated.includes(n))).toEqual([]);
    expect(gated.filter((n) => !destructive.includes(n))).toEqual([]);
    expect(gated.length).toBeGreaterThan(0);
  });

  it('declares no precondition the server does not register', () => {
    // preconditionMiddleware throws at call time for an unknown id, so a typo
    // here is a runtime 500 on the affected tool only - invisible until called.
    for (const t of tools) {
      for (const p of t.preconditions) {
        expect(IMPLEMENTED_PRECONDITIONS.has(p), `${t.name} declares '${p}'`).toBe(true);
      }
    }
  });

  it('never marks a tool both readOnly and destructive', () => {
    const contradictory = tools
      .filter((t) => t.annotations.readOnlyHint === true && t.annotations.destructiveHint === true)
      .map((t) => t.name);
    expect(contradictory).toEqual([]);
  });

  it('declares every annotation hint explicitly', () => {
    // MCP clients treat a missing hint as "unknown" and some default to the
    // unsafe reading. Every tool states all four.
    const incomplete = tools
      .filter(
        (t) =>
          typeof t.annotations.readOnlyHint !== 'boolean' ||
          typeof t.annotations.destructiveHint !== 'boolean' ||
          typeof t.annotations.idempotentHint !== 'boolean' ||
          typeof t.annotations.openWorldHint !== 'boolean',
      )
      .map((t) => t.name);
    expect(incomplete).toEqual([]);
  });

  it('names every tool `<category>_<verb>` and keeps it MCP-legal', () => {
    // Two categories ship a prefix that differs from the directory name. Both
    // predate the freeze and renaming a tool is a breaking change, so they are
    // allowlisted rather than "fixed" - the point of the check is to catch a
    // NEW tool landing under the wrong prefix.
    const PREFIX_EXCEPTIONS: Record<string, readonly string[]> = {
      meta: ['mcp_'],
      monetization: ['entitlements_', 'skus_', 'subscriptions_'],
    };
    for (const t of tools) {
      expect(t.name, t.sourcePath).toMatch(/^[a-z][a-z0-9_]*$/);
      const allowed = PREFIX_EXCEPTIONS[t.category] ?? [`${t.category.replace(/-/g, '_')}_`];
      expect(
        allowed.some((p) => t.name.startsWith(p)),
        `${t.name} (category ${t.category}) must start with one of ${allowed.join(', ')}`,
      ).toBe(true);
    }
  });

  it('never declares an input parameter no handler can receive', () => {
    // `__confirm` is an authorization flag stripped by validateMiddleware and
    // read from the raw payload by ConfirmRequired. A tool that declares it -
    // or a lookalike like `confirm` - is advertising a parameter that is
    // either silently dropped or duplicates the gate.
    for (const t of tools) {
      const keys = Object.keys(t.inputSchema);
      expect(keys, t.name).not.toContain('__confirm');
      expect(keys, t.name).not.toContain('confirm');
    }
  });
});
