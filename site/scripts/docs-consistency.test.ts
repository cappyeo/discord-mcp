/**
 * Drift guard: the confirmation architecture page must enumerate exactly the
 * tools that actually carry the `confirm_required` precondition.
 *
 * This page documents the product's load-bearing safety primitive. It drifted
 * for twelve releases claiming "roughly 70 tools" gated by `idempotent: false`
 * while the real mechanism is an explicit per-tool opt-in covering 29. An
 * operator reading the stale copy would ship believing nothing could mutate
 * Discord without confirmation.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadAllTools } from './generate-tool-docs.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(__dirname, '../..');
const CONFIRMATION_MDX = join(ROOT, 'site/src/content/docs/architecture/confirmation.mdx');

/** Backticked snake_case identifiers, e.g. `messages_delete`. */
const BACKTICKED = /`([a-z][a-z0-9]*(?:_[a-z0-9]+)+)`/g;

describe('confirmation.mdx enumerates the real confirm-gated tool set', () => {
  it('lists exactly the tools whose metadata declares confirm_required', async () => {
    const tools = await loadAllTools();
    const gated = new Set(
      tools.filter((t) => t.preconditions.includes('confirm_required')).map((t) => t.name),
    );
    expect(gated.size).toBeGreaterThan(0);

    const mdx = readFileSync(CONFIRMATION_MDX, 'utf8');

    // The roll-up table is the enumeration under test. Slice from its heading
    // to the next heading so prose elsewhere on the page can't satisfy it.
    const start = mdx.indexOf('## Which tools require it');
    expect(start, 'confirmation.mdx must keep a "Which tools require it" section').toBeGreaterThan(
      -1,
    );
    const rest = mdx.slice(start + 1);
    const end = rest.indexOf('\n## ');
    const section = end === -1 ? rest : rest.slice(0, end);

    const registered = new Set(tools.map((t) => t.name));
    const mentioned = new Set<string>();
    for (const m of section.matchAll(BACKTICKED)) {
      const name = m[1]!;
      // The section also names non-gated tools in the "NOT gated" callout and
      // refers to the precondition id itself. Only registered tool names count.
      if (registered.has(name)) mentioned.add(name);
    }

    // Every gated tool must appear.
    const missing = [...gated].filter((n) => !mentioned.has(n)).sort();
    expect(missing, 'gated tools missing from confirmation.mdx').toEqual([]);

    // The "NOT gated" callout deliberately names ungated tools, so we cannot
    // assert set equality over the whole section. Assert it over the table.
    const tableRows = section
      .split('\n')
      .filter((l) => l.startsWith('|') && !l.includes('---') && !l.includes('Gated tools'));
    const inTable = new Set<string>();
    for (const row of tableRows) {
      for (const m of row.matchAll(BACKTICKED)) {
        if (registered.has(m[1]!)) inTable.add(m[1]!);
      }
    }
    expect([...inTable].sort(), 'confirmation.mdx table vs registry').toEqual([...gated].sort());
  });

  it('states the gated count as a number matching the registry', async () => {
    const tools = await loadAllTools();
    const count = tools.filter((t) => t.preconditions.includes('confirm_required')).length;
    const mdx = readFileSync(CONFIRMATION_MDX, 'utf8');
    expect(
      mdx.includes(`**${count} tools**`),
      `confirmation.mdx must state "**${count} tools**" (registry has ${count} confirm-gated tools)`,
    ).toBe(true);
  });

  it('does not resurrect the inverted "idempotent: false is the source of truth" claim', () => {
    const mdx = readFileSync(CONFIRMATION_MDX, 'utf8');
    expect(mdx).not.toMatch(/idempotent:\s*false.{0,80}source of truth/is);
    expect(mdx).not.toMatch(/Every tool with `idempotent: false`/);
  });

  it('names the mutating tools that are NOT gated, so operators are not surprised', async () => {
    const tools = await loadAllTools();
    const registered = new Set(tools.map((t) => t.name));
    const gated = new Set(
      tools.filter((t) => t.preconditions.includes('confirm_required')).map((t) => t.name),
    );
    const mdx = readFileSync(CONFIRMATION_MDX, 'utf8');

    const mustWarnAbout = [
      'messages_send',
      'messages_edit',
      'channels_create_guild_channel',
      'webhooks_execute',
      'roles_create',
      'members_add_role',
      'components_v2_send',
    ];
    for (const name of mustWarnAbout) {
      // Guard the guard: if one of these ever becomes gated, this list is stale.
      expect(registered.has(name), `${name} should be a registered tool`).toBe(true);
      expect(gated.has(name), `${name} is now gated — update the NOT-gated callout`).toBe(false);
      expect(mdx.includes(`\`${name}\``), `confirmation.mdx must name \`${name}\``).toBe(true);
    }
  });
});
