/**
 * Hubdustry Go MCP adapter - Plan 9 Phase E reference implementation.
 *
 * The original Hubdustry upstream is no longer publicly reachable. The
 * repository therefore ships a synthetic Hubdustry-shaped fixture with
 * file and deploy tools. None are Discord tools, so the fixture produces
 * `0 mapped, N unmapped, 0 manual review`. That's the intended output:
 * it demonstrates the framework while honestly reporting that the source
 * and discord-mcp have no overlapping operations.
 *
 * Detection strategy: look for `apps/mcp/main.go` or a top-level
 * `main.go` and read it; if either contains `hubdustry` or the
 * `mcp.NewTool` call pattern we consider this a Hubdustry-shaped repo.
 *
 * Tool extraction: regex over `*.go` files under `tools/` for the
 * `mcp.NewTool("name"` pattern. This is best-effort - it will miss
 * multi-line calls and any tool name built via concatenation. The
 * adapter is documented to be best-effort; users can extend or
 * hand-edit the result.
 */
import type { Dirent } from 'node:fs';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { MigrationResult, MigrationSource } from './types.js';

/**
 * Hubdustry tool name → discord-mcp tool name. Empty by design: every
 * Hubdustry tool is non-Discord. Future Hubdustry forks that DO use
 * Discord (or a Hubdustry rewrite that adds Discord-bot tools) would
 * populate entries here.
 */
const NAME_MAP: Record<string, string> = {
  // intentionally empty - see file-level JSDoc.
};

/**
 * Resolve the actual Hubdustry root: prefer `<rootPath>/apps/mcp` (the
 * monorepo layout the user runs locally), fall back to `<rootPath>`
 * itself (a standalone clone of just the mcp app). Returns the
 * unchanged `rootPath` if neither candidate has a `main.go` - `migrate`
 * then proceeds and reports "no tools found" via `warnings`.
 */
function detectActualPath(rootPath: string): string {
  const monorepoCandidate = join(rootPath, 'apps', 'mcp');
  try {
    statSync(join(monorepoCandidate, 'main.go'));
    return monorepoCandidate;
  } catch {
    // not the monorepo layout - try the direct layout below.
  }
  try {
    statSync(join(rootPath, 'main.go'));
    return rootPath;
  } catch {
    // neither found - let migrate() report empty results.
  }
  return rootPath;
}

/**
 * Recursively list `*.go` files under `dir` (excluding `_test.go`).
 * Returns an empty array if `dir` is missing or unreadable.
 */
function readDirGoFiles(dir: string): string[] {
  const out: string[] = [];
  let entries: Dirent[];
  try {
    // Force string-mode Dirent. The default overload picks `Buffer` when
    // tsc can't narrow the encoding from the args alone (Node 22 types).
    entries = readdirSync(dir, { withFileTypes: true, encoding: 'utf8' }) as Dirent[];
  } catch {
    return out;
  }
  for (const entry of entries) {
    const name = entry.name;
    const full = join(dir, name);
    if (entry.isDirectory()) {
      out.push(...readDirGoFiles(full));
    } else if (entry.isFile() && name.endsWith('.go') && !name.endsWith('_test.go')) {
      out.push(full);
    }
  }
  return out;
}

export const hubdustryGoMcpAdapter: MigrationSource = {
  id: 'hubdustry-go-mcp',
  description: 'Hubdustry-shaped Go MCP fixture - non-Discord reference adapter',
  languages: ['go'],

  async detect(rootPath: string): Promise<boolean> {
    const candidates = [join(rootPath, 'main.go'), join(rootPath, 'apps', 'mcp', 'main.go')];
    for (const path of candidates) {
      try {
        statSync(path);
        const content = readFileSync(path, 'utf8');
        if (content.includes('hubdustry') || content.includes('mcp.NewTool')) {
          return true;
        }
      } catch {
        // file missing or unreadable - try the next candidate.
      }
    }
    return false;
  },

  async migrate(rootPath: string): Promise<MigrationResult> {
    const sourcePath = detectActualPath(rootPath);
    const toolsDir = join(sourcePath, 'tools');

    const allTools: string[] = [];
    const warnings: string[] = [];

    const files = readDirGoFiles(toolsDir);
    for (const file of files) {
      let content: string;
      try {
        content = readFileSync(file, 'utf8');
      } catch (e) {
        warnings.push(`could not read ${file}: ${e instanceof Error ? e.message : String(e)}`);
        continue;
      }
      // Best-effort: matches `mcp.NewTool("tool.name"` on a single line.
      // Multi-line calls or concatenated names will be missed.
      const re = /mcp\.NewTool\s*\(\s*"([^"]+)"/g;
      for (const match of content.matchAll(re)) {
        const name = match[1];
        if (name !== undefined && !allTools.includes(name)) {
          allTools.push(name);
        }
      }
    }

    if (allTools.length === 0) {
      warnings.push('no mcp.NewTool calls found - adapter may not match this Hubdustry version');
    }

    const mappedTools = allTools
      .filter((name) => NAME_MAP[name] !== undefined)
      .map((name) => {
        const mapped = NAME_MAP[name];
        // NAME_MAP[name] is non-undefined per the filter; assert via local.
        if (mapped === undefined) {
          // unreachable, but the type narrowing requires this branch.
          throw new Error(`unreachable: ${name} passed filter but NAME_MAP returned undefined`);
        }
        return {
          original: name,
          mapped,
          confidence: 'high' as const,
        };
      });

    const unmappedTools = allTools.filter((name) => NAME_MAP[name] === undefined);

    return {
      source: 'hubdustry-go-mcp',
      sourcePath,
      mappedTools,
      unmappedTools,
      manualReview: [],
      warnings,
    };
  },
};
