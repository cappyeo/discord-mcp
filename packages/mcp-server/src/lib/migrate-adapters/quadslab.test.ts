/**
 * quadslab adapter unit tests - Plan 11 Phase C.
 *
 * Tests run against the synthetic fixture under
 * `packages/mcp-server/test-fixtures/quadslab/`. The fixture lives outside
 * `src/` so it isn't compiled, isn't packed (the package `files: ["dist",
 * ...]` allowlist excludes it), and isn't lint-checked.
 *
 * Fixture contents - 8 known tool literals across four modules:
 *   messages.ts:  send_message, edit_message, get_messages          (3 mapped)
 *   channels.ts:  list_channels, create_text_channel                (2 mapped)
 *   presence.ts:  set_bot_status, get_bot_info                      (2 unmapped)
 *   templates.ts: list_templates                                    (1 mapped)
 *
 * Six of those have a discord-mcp equivalent in NAME_MAP; the other
 * two are intentional unmapped cases (presence is gateway-only).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { pasympaAdapter } from './pasympa.js';
import { quadslabAdapter } from './quadslab.js';

// `src/lib/migrate-adapters/quadslab.test.ts` is three directories below
// the package root, where `test-fixtures/` lives.
const PACKAGE_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const FIXTURE_ROOT = join(PACKAGE_ROOT, 'test-fixtures', 'quadslab');
const PASYMPA_FIXTURE_ROOT = join(PACKAGE_ROOT, 'test-fixtures', 'pasympa');

describe('quadslabAdapter - id + description + Plan 11 Phase A metadata', () => {
  it('exposes a stable kebab-case id', () => {
    expect(quadslabAdapter.id).toBe('quadslab');
  });

  it('has a non-empty description that mentions quadslab', () => {
    expect(quadslabAdapter.description.length).toBeGreaterThan(10);
    expect(quadslabAdapter.description).toContain('quadslab');
  });

  it('declares the upstream homepage link', () => {
    expect(quadslabAdapter.homepage).toBe('https://github.com/HardHeadHackerHead/discord-mcp');
  });

  it('declares languages: ["typescript"] and toolCountEstimate: 139', () => {
    expect(quadslabAdapter.languages).toEqual(['typescript']);
    expect(quadslabAdapter.toolCountEstimate).toBe(139);
  });
});

describe('quadslabAdapter - detect()', () => {
  it('returns true for the synthetic fixture (package.json + tools dir)', async () => {
    expect(await quadslabAdapter.detect(FIXTURE_ROOT)).toBe(true);
  });

  it('returns false for a fresh empty directory (no package.json)', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'quadslab-detect-empty-'));
    try {
      expect(await quadslabAdapter.detect(empty)).toBe(false);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('returns false for a non-existent path (does not throw)', async () => {
    expect(await quadslabAdapter.detect('C:/this/path/should/not/exist/anywhere')).toBe(false);
  });

  it('returns false when package.json matches but no quadslab-shape file exists', async () => {
    // Multi-signal detection: name alone isn't enough. Build a temp
    // directory with a quadslab-named package.json but no source files -
    // detect() must reject because the content signal is missing.
    const dir = mkdtempSync(join(tmpdir(), 'quadslab-detect-namelyok-'));
    try {
      writeFileSync(
        join(dir, 'package.json'),
        JSON.stringify({ name: '@quadslab.io/discord-mcp', version: '0.0.0' }),
        'utf8',
      );
      expect(await quadslabAdapter.detect(dir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns false when package.json name does not match (even with toolsExport + executor)', async () => {
    // Inverse case: a TypeScript repo that happens to use the
    // `<x>Tools` + `execute<X>Tool` pattern but isn't quadslab must NOT
    // trigger detect(). The name guard MUST short-circuit first.
    const dir = mkdtempSync(join(tmpdir(), 'quadslab-detect-namemismatch-'));
    try {
      writeFileSync(
        join(dir, 'package.json'),
        JSON.stringify({ name: 'some-other-discord-bot', version: '0.0.0' }),
        'utf8',
      );
      const tools = join(dir, 'src', 'tools');
      mkdirSync(tools, { recursive: true });
      writeFileSync(
        join(tools, 't.ts'),
        'export const fooTools = [];\nexport function executeFooTool() { return null; }\n',
        'utf8',
      );
      expect(await quadslabAdapter.detect(dir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns false on the PaSympa fixture (no cross-detection false positive)', async () => {
    // Critical cross-adapter check: PaSympa's package.json says
    // `@pasympa/discord-mcp`, which doesn't match `/quadslab/i`, AND
    // its source uses `export const sendMessage = ...` (not the
    // `<x>Tools` aggregate-array pattern). Both signals must reject.
    expect(await quadslabAdapter.detect(PASYMPA_FIXTURE_ROOT)).toBe(false);
  });

  it('PaSympa detect() also returns false on the quadslab fixture (inverse cross-check)', async () => {
    // The quadslab fixture's package.json says `@quadslab.io/discord-mcp`,
    // which doesn't match any of PaSympa's name patterns. PaSympa's
    // detect() must reject. This guards against accidental adapter
    // overlap if a future fixture change reintroduces `discord_*`
    // literals into the quadslab fixture.
    expect(await pasympaAdapter.detect(FIXTURE_ROOT)).toBe(false);
  });
});

describe('quadslabAdapter - migrate()', () => {
  it('reports 6 mapped tools and 2 unmapped tools against the fixture', async () => {
    const result = await quadslabAdapter.migrate(FIXTURE_ROOT);
    expect(result.source).toBe('quadslab');
    expect(result.sourcePath).toBe(FIXTURE_ROOT);
    expect(result.manualReview.length).toBe(0);
    // 8 fixture tools total: 6 in NAME_MAP, 2 intentional unmapped (presence).
    expect(result.mappedTools.length).toBe(6);
    expect(result.unmappedTools.length).toBe(2);
    expect(result.unmappedTools).toContain('set_bot_status');
    expect(result.unmappedTools).toContain('get_bot_info');
    expect(result.mappedTools).toContainEqual(
      expect.objectContaining({ original: 'list_templates', mapped: 'templates_list' }),
    );
  });

  it('maps the six known tools to their discord-mcp equivalents', async () => {
    const result = await quadslabAdapter.migrate(FIXTURE_ROOT);
    const byOriginal = new Map(result.mappedTools.map((t) => [t.original, t]));
    expect(byOriginal.get('send_message')?.mapped).toBe('messages_send');
    expect(byOriginal.get('edit_message')?.mapped).toBe('messages_edit');
    expect(byOriginal.get('get_messages')?.mapped).toBe('messages_read');
    expect(byOriginal.get('list_channels')?.mapped).toBe('channels_list');
    expect(byOriginal.get('create_text_channel')?.mapped).toBe('channels_create_guild_channel');
    expect(byOriginal.get('list_templates')?.mapped).toBe('templates_list');
    // Every mapped tool must carry one of the three confidence levels.
    for (const tool of result.mappedTools) {
      expect(['high', 'medium', 'low']).toContain(tool.confidence);
    }
  });

  it('flags 1:1 message/channel tools as high-confidence', async () => {
    const result = await quadslabAdapter.migrate(FIXTURE_ROOT);
    const byOriginal = new Map(result.mappedTools.map((t) => [t.original, t]));
    expect(byOriginal.get('send_message')?.confidence).toBe('high');
    expect(byOriginal.get('edit_message')?.confidence).toBe('high');
    expect(byOriginal.get('get_messages')?.confidence).toBe('high');
    expect(byOriginal.get('list_channels')?.confidence).toBe('high');
  });

  it('attaches notes on tools that need argument adjustments', async () => {
    const result = await quadslabAdapter.migrate(FIXTURE_ROOT);
    const byOriginal = new Map(result.mappedTools.map((t) => [t.original, t]));
    // create_text_channel is high-confidence but carries a note
    // explaining the type=0 requirement.
    expect(byOriginal.get('create_text_channel')?.notes).toContain('type=0');
  });

  it('emits no warnings against a valid fixture', async () => {
    const result = await quadslabAdapter.migrate(FIXTURE_ROOT);
    expect(result.warnings).toEqual([]);
  });

  it('emits a "no quadslab tool names found" warning for an empty source dir', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'quadslab-migrate-empty-'));
    try {
      const result = await quadslabAdapter.migrate(empty);
      expect(result.mappedTools.length).toBe(0);
      expect(result.unmappedTools.length).toBe(0);
      expect(result.warnings.some((w) => w.includes('no quadslab tool names found'))).toBe(true);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
