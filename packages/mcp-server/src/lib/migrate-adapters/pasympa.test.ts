/**
 * PaSympa adapter unit tests - Plan 11 Phase B.
 *
 * Tests run against the synthetic fixture under
 * `packages/mcp-server/test-fixtures/pasympa/`. The fixture lives outside
 * `src/` so it isn't compiled, isn't packed (the package `files: ["dist",
 * ...]` allowlist excludes it), and isn't lint-checked.
 *
 * The fixture contains 6 `discord_*` tool literals across two modules:
 *   messages.ts: discord_send_message, discord_read_messages, discord_edit_message
 *   channels.ts: discord_list_channels, discord_create_channel, discord_audit_alert
 *
 * Five of those are in NAME_MAP (mapped); `discord_audit_alert` is the
 * explicit "PaSympa-specific, no equivalent" synthetic and falls into
 * `unmappedTools`.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { pasympaAdapter } from './pasympa.js';

// `src/lib/migrate-adapters/pasympa.test.ts` is three directories below
// the package root, where `test-fixtures/` lives.
const PACKAGE_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const FIXTURE_ROOT = join(PACKAGE_ROOT, 'test-fixtures', 'pasympa');

describe('pasympaAdapter - id + description + Plan 11 Phase A metadata', () => {
  it('exposes a stable kebab-case id', () => {
    expect(pasympaAdapter.id).toBe('pasympa');
  });

  it('has a non-empty description that mentions PaSympa', () => {
    expect(pasympaAdapter.description.length).toBeGreaterThan(10);
    expect(pasympaAdapter.description).toContain('PaSympa');
  });

  it('declares the upstream homepage link', () => {
    expect(pasympaAdapter.homepage).toBe('https://github.com/PaSympa/discord-mcp');
  });

  it('declares languages: ["typescript"] and toolCountEstimate: 91', () => {
    expect(pasympaAdapter.languages).toEqual(['typescript']);
    expect(pasympaAdapter.toolCountEstimate).toBe(91);
  });
});

describe('pasympaAdapter - detect()', () => {
  it('returns true for the synthetic fixture (package.json + tools dir)', async () => {
    expect(await pasympaAdapter.detect(FIXTURE_ROOT)).toBe(true);
  });

  it('returns false for a fresh empty directory (no package.json)', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'pasympa-detect-empty-'));
    try {
      expect(await pasympaAdapter.detect(empty)).toBe(false);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('returns false for a non-existent path (does not throw)', async () => {
    expect(await pasympaAdapter.detect('C:/this/path/should/not/exist/anywhere')).toBe(false);
  });

  it('returns false when package.json matches but no discord_* literals exist', async () => {
    // Multi-signal detection: name alone isn't enough. Build a temp
    // directory with a PaSympa-named package.json but no source files -
    // detect() must reject because the content signal is missing.
    const dir = mkdtempSync(join(tmpdir(), 'pasympa-detect-namelyok-'));
    try {
      writeFileSync(
        join(dir, 'package.json'),
        JSON.stringify({ name: '@pasympa/discord-mcp', version: '0.0.0' }),
        'utf8',
      );
      expect(await pasympaAdapter.detect(dir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns false when package.json name does not match (even with discord_ literals)', async () => {
    // The inverse of the above: a TypeScript repo that happens to use
    // `discord_*` strings but isn't PaSympa must NOT trigger detect().
    const dir = mkdtempSync(join(tmpdir(), 'pasympa-detect-namemismatch-'));
    try {
      writeFileSync(
        join(dir, 'package.json'),
        JSON.stringify({ name: 'some-other-discord-bot', version: '0.0.0' }),
        'utf8',
      );
      // Even with a matching content signal, the name guard should bail.
      const tools = join(dir, 'src', 'tools');
      // build dirs manually since mkdirSync isn't imported here; piggyback
      // on writeFileSync's path creation? No - Node won't auto-mkdir.
      // Use fs.mkdirSync via dynamic import to keep imports minimal.
      const { mkdirSync } = await import('node:fs');
      mkdirSync(tools, { recursive: true });
      writeFileSync(
        join(tools, 't.ts'),
        "export const x = { name: 'discord_send_message' };",
        'utf8',
      );
      expect(await pasympaAdapter.detect(dir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('pasympaAdapter - migrate()', () => {
  it('reports 5 mapped tools and 1 unmapped tool against the fixture', async () => {
    const result = await pasympaAdapter.migrate(FIXTURE_ROOT);
    expect(result.source).toBe('pasympa');
    expect(result.sourcePath).toBe(FIXTURE_ROOT);
    expect(result.manualReview.length).toBe(0);
    // 6 fixture tools total: 5 in NAME_MAP, 1 synthesised unmappable.
    expect(result.mappedTools.length).toBe(5);
    expect(result.unmappedTools.length).toBe(1);
    expect(result.unmappedTools).toContain('discord_audit_alert');
  });

  it('maps the five known tools to their discord-mcp equivalents', async () => {
    const result = await pasympaAdapter.migrate(FIXTURE_ROOT);
    const byOriginal = new Map(result.mappedTools.map((t) => [t.original, t]));
    expect(byOriginal.get('discord_send_message')?.mapped).toBe('messages_send');
    expect(byOriginal.get('discord_read_messages')?.mapped).toBe('messages_read');
    expect(byOriginal.get('discord_edit_message')?.mapped).toBe('messages_edit');
    expect(byOriginal.get('discord_list_channels')?.mapped).toBe('channels_list');
    expect(byOriginal.get('discord_create_channel')?.mapped).toBe('channels_create_guild_channel');
    // The five tools we DID map should all carry confidence levels.
    for (const tool of result.mappedTools) {
      expect(['high', 'medium', 'low']).toContain(tool.confidence);
    }
  });

  it('flags messages tools as high-confidence (1:1 names)', async () => {
    const result = await pasympaAdapter.migrate(FIXTURE_ROOT);
    const byOriginal = new Map(result.mappedTools.map((t) => [t.original, t]));
    expect(byOriginal.get('discord_send_message')?.confidence).toBe('high');
    expect(byOriginal.get('discord_read_messages')?.confidence).toBe('high');
    expect(byOriginal.get('discord_edit_message')?.confidence).toBe('high');
    expect(byOriginal.get('discord_list_channels')?.confidence).toBe('high');
  });

  it('emits no warnings against a valid fixture', async () => {
    const result = await pasympaAdapter.migrate(FIXTURE_ROOT);
    expect(result.warnings).toEqual([]);
  });

  it('emits a "no discord_* tool names found" warning for an empty source dir', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'pasympa-migrate-empty-'));
    try {
      const result = await pasympaAdapter.migrate(empty);
      expect(result.mappedTools.length).toBe(0);
      expect(result.unmappedTools.length).toBe(0);
      expect(result.warnings.some((w) => w.includes('no discord_*'))).toBe(true);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  // Defensive cleanup in case any test left a temp dir behind.
  afterAll(() => {
    // No persistent state to clean here - temp dirs are scoped per-test.
  });
});
