/**
 * Drift guard: every tool name a HAND-WRITTEN doc page mentions must exist in
 * the real registry.
 *
 * The generated pages under `src/content/docs/tools/` are rebuilt from
 * `__toolMetadata` and cannot drift. The hand-written pages can, and did - for
 * twelve releases they advertised `roles_add`, `components_v2_build_action_row`
 * and five fabricated `intelligence_*` names that an agent would happily try to
 * call.
 *
 * Method:
 *   1. Walk every hand-written .mdx / .md, excluding the generated tools tree.
 *   2. STRIP FENCED CODE BLOCKS FIRST - worked examples legitimately contain
 *      hypothetical tools, other projects' tool names (migration guides), and
 *      JSON payloads we do not want to police.
 *   3. Match backticked snake_case identifiers whose prefix is a known tool
 *      category, and assert each one is registered.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadAllTools } from './generate-tool-docs.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(__dirname, '../..');
const DOC_ROOTS = [join(ROOT, 'site/src/content/docs')];
const GATEWAY_HANDLERS_DIR = join(ROOT, 'packages/mcp-core/src/gateway/handlers');

const EXCLUDED_DIRS = [
  // Auto-generated from the registry - cannot drift.
  join(ROOT, 'site/src/content/docs/tools'),
  // Migration guides describe OTHER projects' tool surfaces (`messages_lite`,
  // `discord_send_message`, …). Foreign names there are correct by definition.
  join(ROOT, 'site/src/content/docs/migrate'),
];
const FENCED = /^```[\s\S]*?^```/gm;
const INDENTED_MDX_FENCE = /^\s*```[\s\S]*?^\s*```/gm;
const BACKTICKED = /`([a-z][a-z0-9]*(?:_[a-z0-9]+)+)`/g;

/**
 * Identifiers that share a category prefix but are not tools. Gateway handler
 * names collide with the `guild_`, `voice_`, and `audit_log_` prefixes; they
 * are validated separately against the handlers directory.
 */
function buildExtras(): Set<string> {
  const handlers = readdirSync(GATEWAY_HANDLERS_DIR)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map((f) => f.replace(/\.ts$/, ''));
  return new Set<string>([
    ...handlers,
    // Precondition identifiers, not tools.
    'confirm_required',
    'category_enabled',
  ]);
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (
      EXCLUDED_DIRS.some((d) => full === d || full.startsWith(`${d}\\`) || full.startsWith(`${d}/`))
    )
      continue;
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
    } else if (full.endsWith('.mdx') || full.endsWith('.md')) {
      out.push(full);
    }
  }
  return out;
}

function stripCode(src: string): string {
  return src.replace(FENCED, '').replace(INDENTED_MDX_FENCE, '');
}

describe('hand-written docs only reference registered tools', () => {
  it('every backticked category-prefixed identifier is a real tool', async () => {
    const tools = await loadAllTools();
    const registered = new Set(tools.map((t) => t.name));
    expect(registered.size).toBeGreaterThan(150);

    // A prefix is "known" only when some registered tool actually uses it, so
    // the guard tracks the registry rather than a hand-maintained list.
    const prefixes = new Set<string>();
    for (const t of tools) {
      if (t.name.startsWith(`${t.category}_`)) prefixes.add(t.category);
    }
    expect(prefixes.has('messages')).toBe(true);
    expect(prefixes.has('components_v2')).toBe(true);

    const extras = buildExtras();
    const isToolLike = (id: string): boolean =>
      [...prefixes].some((p) => id.startsWith(`${p}_`)) && !extras.has(id) && !/_ids?$/.test(id);

    const files = DOC_ROOTS.flatMap((d) => walk(d));
    expect(files.length).toBeGreaterThan(20);

    const bad: string[] = [];
    for (const file of files) {
      const prose = stripCode(readFileSync(file, 'utf8'));
      const seen = new Set<string>();
      for (const m of prose.matchAll(BACKTICKED)) {
        const id = m[1]!;
        if (seen.has(id) || !isToolLike(id) || registered.has(id)) continue;
        seen.add(id);
        bad.push(`${relative(ROOT, file).replace(/\\/g, '/')}: \`${id}\``);
      }
    }

    expect(bad.sort(), 'hand-written docs reference tools that do not exist').toEqual([]);
    // loadAllTools dynamically imports all 208 tool sources through tsx.
  }, 60_000);
});

/**
 * The prose guard above strips fenced blocks wholesale, which is right for
 * migration guides and hypothetical snippets - but it also blinded it to the
 * two places a wrong tool name does the most damage: the `"tool"` field of a
 * pipeline example, and a mermaid sequence diagram. `roles_add` (which has
 * never existed; the real name is `members_add_role`) lived in exactly those
 * two spots in `architecture/pipeline.mdx` and the prose guard could not see
 * either one.
 *
 * These are copy-paste surfaces: an agent reading a pipeline example will
 * reproduce the tool name verbatim.
 */
describe('tool names inside code examples', () => {
  /** `"tool": "x"` - the pipeline step schema. Unambiguous, no false positives. */
  const PIPELINE_TOOL_FIELD = /"tool"\s*:\s*"([a-z0-9_]+)"/g;

  it('every `"tool": "..."` in a worked example is a real tool', async () => {
    const tools = await loadAllTools();
    const registered = new Set(tools.map((t) => t.name));
    const files = DOC_ROOTS.flatMap((d) => walk(d));

    const bad: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(PIPELINE_TOOL_FIELD)) {
        const id = m[1]!;
        if (registered.has(id)) continue;
        bad.push(`${relative(ROOT, file).replace(/\\/g, '/')}: "tool": "${id}"`);
      }
    }
    expect(bad.sort(), 'pipeline examples reference tools that do not exist').toEqual([]);
  }, 60_000);

  it('every tool-shaped identifier in a mermaid diagram is a real tool', async () => {
    const tools = await loadAllTools();
    const registered = new Set(tools.map((t) => t.name));
    const prefixes = new Set(
      tools.filter((t) => t.name.startsWith(`${t.category}_`)).map((t) => t.category),
    );
    const extras = buildExtras();
    // `guild_id`, `message_ids`, `channel_id` … are argument names that share a
    // category prefix. They are not tools and must not be flagged.
    const isToolLike = (id: string): boolean =>
      [...prefixes].some((p) => id.startsWith(`${p}_`)) && !extras.has(id) && !/_ids?$/.test(id);

    const MERMAID = /^```mermaid\n([\s\S]*?)^```/gm;
    const IDENT = /\b([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\b/g;

    const bad: string[] = [];
    for (const file of DOC_ROOTS.flatMap((d) => walk(d))) {
      const src = readFileSync(file, 'utf8');
      for (const block of src.matchAll(MERMAID)) {
        for (const m of block[1]!.matchAll(IDENT)) {
          const id = m[1]!;
          if (!isToolLike(id) || registered.has(id)) continue;
          bad.push(`${relative(ROOT, file).replace(/\\/g, '/')}: ${id}`);
        }
      }
    }
    expect([...new Set(bad)].sort(), 'mermaid diagrams reference tools that do not exist').toEqual(
      [],
    );
  }, 60_000);
});

describe('gateway handler names in prose match the handlers directory', () => {
  const handlers = readdirSync(GATEWAY_HANDLERS_DIR)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map((f) => f.replace(/\.ts$/, ''))
    .sort();

  it('the handlers directory is non-empty (guards the guard)', () => {
    expect(handlers.length).toBeGreaterThan(0);
  });

  it('gateway.mdx documents exactly the handlers that exist', () => {
    const mdx = readFileSync(join(ROOT, 'site/src/content/docs/architecture/gateway.mdx'), 'utf8');
    const referenced = new Set([...mdx.matchAll(/handlers\/([a-z_]+)\.ts/g)].map((m) => m[1]!));
    expect([...referenced].sort(), 'architecture/gateway.mdx vs gateway/handlers/').toEqual(
      handlers,
    );
    expect(
      mdx.includes(`${handlers.length} handlers`),
      `gateway.mdx should say "${handlers.length} handlers"`,
    ).toBe(true);
  });

  it('the changelog names only real handlers', () => {
    const mdx = readFileSync(join(ROOT, 'site/src/content/docs/reference/changelog.mdx'), 'utf8');
    const line = mdx.split('\n').find((l) => /Gateway event handlers/.test(l));
    expect(line, 'changelog.mdx must keep a "Gateway event handlers" bullet').toBeDefined();

    // Collect the backticked identifiers on that bullet and the lines that
    // continue it (markdown wraps at ~76 cols).
    const lines = mdx.split('\n');
    const start = lines.indexOf(line!);
    const bullet = [lines[start]!];
    for (let i = start + 1; i < lines.length && /^\s+\S/.test(lines[i]!); i++) {
      bullet.push(lines[i]!);
    }
    const named = [...bullet.join('\n').matchAll(/`([A-Za-z_]+)`/g)].map((m) => m[1]!);
    expect(named.length).toBeGreaterThan(0);
    const unknown = named.filter((n) => !handlers.includes(n)).sort();
    expect(unknown, 'changelog.mdx names handlers that do not exist').toEqual([]);
  });
});
