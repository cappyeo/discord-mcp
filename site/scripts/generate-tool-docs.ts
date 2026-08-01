/**
 * Auto-generate the tools reference section of the docs site.
 *
 * Reads the static `__toolMetadata` attached to every class returned by
 * `defineTool()` (see packages/mcp-core/src/tools/_lib/defineTool.ts) via
 * dynamic `import()` of each tool source file. Renders one MDX page per
 * tool, one index per category, and a top-level tools index — 192 + 28 + 1
 * pages total.
 *
 * Run via `pnpm --filter site generate-tools`. Requires `tsx` to register
 * the TypeScript loader for dynamic .ts imports.
 */
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
// Resolve zod via the mcp-core workspace package — pnpm ensures
// packages/mcp-core/node_modules/zod is always present for the workspace,
// avoiding a duplicate zod copy at site/node_modules that would conflict
// with Astro's content schema (which uses its own bundled zod via
// astro:content).
import { z } from '../../packages/mcp-core/node_modules/zod/index.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(__dirname, '../..');
const TOOLS_DIR = join(ROOT, 'packages/mcp-core/src/tools');
const OUT_DIR = join(__dirname, '../src/content/docs/tools');

export interface ToolMetadata {
  name: string;
  category: string;
  description: string;
  inputSchema: Record<string, z.ZodTypeAny>;
  outputSchema: Record<string, z.ZodTypeAny> | undefined;
  annotations: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
  idempotent: boolean;
  preconditions: readonly string[];
  sourcePath: string;
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export async function loadAllTools(toolsDir: string = TOOLS_DIR): Promise<ToolMetadata[]> {
  const tools: ToolMetadata[] = [];
  const categories = readdirSync(toolsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('_'))
    .map((e) => e.name);

  for (const category of categories) {
    const categoryDir = join(toolsDir, category);
    const files = readdirSync(categoryDir).filter(
      (f) =>
        f.endsWith('.ts') &&
        !f.endsWith('.test.ts') &&
        !f.endsWith('.bench.ts') &&
        !f.startsWith('_'),
    );
    for (const file of files) {
      const sourcePath = join(categoryDir, file);
      const moduleUrl = `file://${sourcePath.replace(/\\/g, '/')}`;
      try {
        const mod = await import(moduleUrl);
        const toolClass = mod.default;
        const metadata = (toolClass as { __toolMetadata?: unknown })?.__toolMetadata;
        if (!metadata || typeof metadata !== 'object') {
          console.warn(`[skip] ${relative(ROOT, sourcePath)} — no __toolMetadata`);
          continue;
        }
        const m = metadata as Record<string, unknown>;
        tools.push({
          name: m.name as string,
          category: m.category as string,
          description: m.description as string,
          inputSchema: m.inputSchema as Record<string, z.ZodTypeAny>,
          outputSchema: m.outputSchema as Record<string, z.ZodTypeAny> | undefined,
          annotations: m.annotations as ToolMetadata['annotations'],
          idempotent: (m.idempotent as boolean) ?? false,
          preconditions: (m.preconditions as readonly string[]) ?? [],
          sourcePath,
        });
      } catch (e) {
        console.warn(
          `[error] ${relative(ROOT, sourcePath)}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
  }
  return tools;
}

// ---------------------------------------------------------------------------
// Tool MDX renderer
// ---------------------------------------------------------------------------

/**
 * Tool descriptions follow the established 4-section format used across the
 * 192 tools. Headings are bold-asterisk markdown — capture body text up to
 * the next bold-asterisk heading or end of string.
 */
export function parseDescription(desc: string): {
  purpose: string;
  whenToUse: string;
  whenNotToUse: string;
  returns: string;
} {
  const sections = { purpose: '', whenToUse: '', whenNotToUse: '', returns: '' };

  const sectionRegex = /\*\*([^*]+)\*\*:\s*([\s\S]*?)(?=\n\s*\*\*[^*]+\*\*:|$)/g;
  for (const m of desc.matchAll(sectionRegex)) {
    const heading = (m[1] ?? '').trim().toLowerCase();
    const body = (m[2] ?? '').trim();
    if (heading === 'purpose') sections.purpose = body;
    else if (heading === 'when to use') sections.whenToUse = body;
    else if (heading === 'when not to use') sections.whenNotToUse = body;
    else if (heading === 'returns') sections.returns = body;
  }

  return sections;
}

/**
 * Escape characters MDX would interpret as JSX. Tool descriptions sometimes
 * contain `<channel_id>` placeholders or `{key:value}` examples that MDX
 * would otherwise try to parse as JSX expressions.
 */
export function escapeMdx(s: string): string {
  return s.replace(/</g, '\\<').replace(/\{/g, '\\{').replace(/\}/g, '\\}');
}

export function renderSchemaTable(fields: Record<string, z.ZodTypeAny> | undefined): string {
  if (!fields || Object.keys(fields).length === 0) return '*(no fields)*';

  const objSchema = z.object(fields);
  let jsonSchema: {
    properties?: Record<
      string,
      { type?: string | string[]; description?: string; format?: string }
    >;
    required?: string[];
  };
  try {
    jsonSchema = z.toJSONSchema(objSchema, { target: 'draft-2020-12' }) as typeof jsonSchema;
  } catch (e) {
    return `*(schema introspection failed: ${e instanceof Error ? e.message : String(e)})*`;
  }

  const required = new Set(jsonSchema.required ?? []);
  const props = jsonSchema.properties ?? {};

  const rows: string[] = ['| Field | Type | Required | Description |', '|---|---|---|---|'];
  for (const [name, prop] of Object.entries(props)) {
    const type = Array.isArray(prop.type) ? prop.type.join(' \\| ') : (prop.type ?? 'unknown');
    const req = required.has(name) ? 'yes' : 'no';
    // Description text appears inside an MDX paragraph. Escape `<`, `{`, `}`
    // so placeholders like `<channel_id>` and `{{...}}` render as text.
    const description = escapeMdx(prop.description ?? '')
      .replace(/\|/g, '\\|')
      .replace(/\n/g, ' ');
    rows.push(`| \`${name}\` | ${type} | ${req} | ${description} |`);
  }
  return rows.join('\n');
}

export function renderToolMdx(tool: ToolMetadata): string {
  const desc = parseDescription(tool.description);
  const inputTable = renderSchemaTable(tool.inputSchema);
  const outputTable = renderSchemaTable(tool.outputSchema);

  const sourceRelative = relative(ROOT, tool.sourcePath).replace(/\\/g, '/');
  const ghUrl = `https://github.com/cappyeo/discord-mcp/blob/main/${sourceRelative}`;

  // Wrap in single quotes (YAML safe-mode) so colons, brackets, and other YAML
  // metacharacters in the description don't break frontmatter parsing.
  // YAML escapes single quotes by doubling them.
  const fmDescRaw = desc.purpose.replace(/\n/g, ' ').slice(0, 150).trim();
  const fmDesc = `'${fmDescRaw.replace(/'/g, "''")}'`;

  const a = tool.annotations;
  const requiresConfirm = tool.preconditions.includes('confirm_required');

  return `---
title: ${tool.name}
description: ${fmDesc}
---

import { Aside } from '@astrojs/starlight/components';

**Category**: ${tool.category}

<Aside type="tip">
This page is auto-generated from \`${sourceRelative}\`. Edit the source to update.
</Aside>

${escapeMdx(desc.purpose)}

## When to use

${escapeMdx(desc.whenToUse)}

## When NOT to use

${escapeMdx(desc.whenNotToUse)}

## Input

${inputTable}

## Returns

${escapeMdx(desc.returns)}

### Output schema

${outputTable}

## Annotations

| Property | Value |
|---|---|
| Read-only | ${a.readOnlyHint ? 'yes' : 'no'} |
| Destructive | ${a.destructiveHint ? 'yes' : 'no'} |
| Idempotent | ${a.idempotentHint ? 'yes' : 'no'} |
| Open-world | ${a.openWorldHint ? 'yes' : 'no'} |
| Confirmation required | ${requiresConfirm ? 'yes (`__confirm:true` required)' : 'no'} |

## Source

[\`${sourceRelative}\`](${ghUrl})
`;
}

// ---------------------------------------------------------------------------
// Index renderers
// ---------------------------------------------------------------------------

function titleCaseCategory(category: string): string {
  return category.charAt(0).toUpperCase() + category.slice(1).replace(/[_-]/g, ' ');
}

export function renderCategoryIndex(category: string, tools: ToolMetadata[]): string {
  const title = titleCaseCategory(category);

  const cards = tools
    .map((t) => {
      const slug = t.name.startsWith(`${category}_`) ? t.name.slice(category.length + 1) : t.name;
      // The description is rendered as a JSX attribute value, so we must
      // HTML-encode `"`, `&`, `<` rather than backslash-escape them.
      const cardDesc = parseDescription(t.description)
        .purpose.replace(/\n/g, ' ')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/"/g, '&quot;')
        .slice(0, 100);
      return `  <LinkCard title="${t.name}" href="/discord-mcp/tools/${category}/${slug}/" description="${cardDesc}" />`;
    })
    .join('\n');

  return `---
title: ${title}
sidebar:
  order: 1
---

import { LinkCard, CardGrid } from '@astrojs/starlight/components';

${tools.length} tool${tools.length === 1 ? '' : 's'} in this category.

<CardGrid>
${cards}
</CardGrid>
`;
}

export function renderToolsIndex(byCategory: Map<string, ToolMetadata[]>): string {
  const total = Array.from(byCategory.values()).reduce((sum, arr) => sum + arr.length, 0);

  const cards = Array.from(byCategory.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([cat, tools]) => {
      const title = titleCaseCategory(cat);
      return `  <LinkCard title="${title} (${tools.length})" href="/discord-mcp/tools/${cat}/" />`;
    })
    .join('\n');

  return `---
title: Tools
sidebar:
  order: 0
---

import { LinkCard, CardGrid } from '@astrojs/starlight/components';

discord-mcp exposes ${total} tools across ${byCategory.size} categories. Every tool
description follows the **Purpose / When to use / When NOT to use / Returns** structure
for predictable agent reasoning.

## Categories

<CardGrid>
${cards}
</CardGrid>
`;
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export interface GenerateOptions {
  toolsDir?: string;
  outDir?: string;
  /** Hard floor for sanity check; build fails if fewer tools load. */
  minTools?: number;
}

export async function generate(opts: GenerateOptions = {}): Promise<{
  tools: ToolMetadata[];
  filesWritten: number;
}> {
  const toolsDir = opts.toolsDir ?? TOOLS_DIR;
  const outDir = opts.outDir ?? OUT_DIR;
  const minTools = opts.minTools ?? 190;

  console.log('[generate-tool-docs] start');

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  const tools = await loadAllTools(toolsDir);
  console.log(`[generate-tool-docs] loaded ${tools.length} tools`);

  if (tools.length < minTools) {
    console.error(`[generate-tool-docs] FATAL: expected >= ${minTools} tools, got ${tools.length}`);
    process.exit(1);
  }

  // Group by category, sort tools alphabetically within each category
  const byCategory = new Map<string, ToolMetadata[]>();
  for (const t of tools) {
    if (!byCategory.has(t.category)) byCategory.set(t.category, []);
    byCategory.get(t.category)!.push(t);
  }
  for (const arr of byCategory.values()) {
    arr.sort((a, b) => a.name.localeCompare(b.name));
  }

  let written = 0;

  for (const tool of tools) {
    const dir = join(outDir, tool.category);
    mkdirSync(dir, { recursive: true });
    const slug = tool.name.startsWith(`${tool.category}_`)
      ? tool.name.slice(tool.category.length + 1)
      : tool.name;
    writeFileSync(join(dir, `${slug}.mdx`), renderToolMdx(tool), 'utf8');
    written++;
  }
  console.log(`[generate-tool-docs] wrote ${written} tool pages`);

  for (const [category, list] of byCategory) {
    writeFileSync(join(outDir, category, 'index.mdx'), renderCategoryIndex(category, list), 'utf8');
    written++;
  }
  console.log(`[generate-tool-docs] wrote ${byCategory.size} category indexes`);

  writeFileSync(join(outDir, 'index.mdx'), renderToolsIndex(byCategory), 'utf8');
  written++;
  console.log('[generate-tool-docs] wrote top-level index');

  console.log(`[generate-tool-docs] done — ${written} files total`);

  return { tools, filesWritten: written };
}

async function main() {
  await generate();
}

const invokedAsMain = (() => {
  if (!process.argv[1]) return false;
  try {
    const argvUrl = new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href;
    return import.meta.url === argvUrl;
  } catch {
    return false;
  }
})();

if (invokedAsMain) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
