/**
 * discord-ops adapter unit tests - Plan 11 Phase D.
 *
 * Tests run against the synthetic fixture under
 * `packages/mcp-server/test-fixtures/discord-ops/`. The fixture lives
 * outside `src/` so it isn't compiled, isn't packed (the package
 * `files: ["dist", ...]` allowlist excludes it), and isn't lint-checked
 * by tsc. Biome still formats it.
 *
 * Fixture contents - 7 tool literals across four modules:
 *   messaging/send-message.ts:    send_message, get_messages, edit_message  (3 mapped, high)
 *   channels/list-channels.ts:    list_channels, set_slowmode               (2 mapped: high + medium)
 *   system/health-check.ts:       health_check, list_projects               (2 unmapped)
 *   messaging/profile-variants.ts: messages_lite                            (1 mapped, medium)
 *
 * Five tools have a discord-mcp equivalent in NAME_MAP; the other two
 * are intentional unmapped cases (system tools have no REST equivalent).
 *
 * 4-WAY CROSS-DETECTION - discord-ops's detect() must reject the PaSympa,
 * quadslab, and Hubdustry fixtures, and the inverse must hold (each of
 * those adapters must reject the discord-ops fixture). This guards
 * against accidental adapter overlap when new fixtures are added.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { discordOpsAdapter } from './discord-ops.js';
import { hubdustryGoMcpAdapter } from './hubdustry-go-mcp.js';
import { pasympaAdapter } from './pasympa.js';
import { quadslabAdapter } from './quadslab.js';

// `src/lib/migrate-adapters/discord-ops.test.ts` is three directories below
// the package root, where `test-fixtures/` lives.
const PACKAGE_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const FIXTURE_ROOT = join(PACKAGE_ROOT, 'test-fixtures', 'discord-ops');
const PASYMPA_FIXTURE_ROOT = join(PACKAGE_ROOT, 'test-fixtures', 'pasympa');
const QUADSLAB_FIXTURE_ROOT = join(PACKAGE_ROOT, 'test-fixtures', 'quadslab');
const HUBDUSTRY_FIXTURE_ROOT = join(PACKAGE_ROOT, 'test-fixtures', 'hubdustry-go-mcp');

describe('discordOpsAdapter - id + description + Plan 11 Phase A metadata', () => {
  it('exposes a stable kebab-case id with hyphen', () => {
    expect(discordOpsAdapter.id).toBe('discord-ops');
  });

  it('has a non-empty description that mentions discord-ops and bookedsolidtech', () => {
    expect(discordOpsAdapter.description.length).toBeGreaterThan(10);
    expect(discordOpsAdapter.description).toContain('discord-ops');
    expect(discordOpsAdapter.description).toContain('bookedsolidtech');
  });

  it('declares the upstream homepage link', () => {
    expect(discordOpsAdapter.homepage).toBe('https://github.com/bookedsolidtech/discord-ops');
  });

  it('declares languages: ["typescript"] and toolCountEstimate: 49', () => {
    expect(discordOpsAdapter.languages).toEqual(['typescript']);
    expect(discordOpsAdapter.toolCountEstimate).toBe(49);
  });
});

describe('discordOpsAdapter - detect()', () => {
  it('returns true for the synthetic fixture (package.json + defineTool/category)', async () => {
    expect(await discordOpsAdapter.detect(FIXTURE_ROOT)).toBe(true);
  });

  it('returns false for a fresh empty directory (no package.json)', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'discord-ops-detect-empty-'));
    try {
      expect(await discordOpsAdapter.detect(empty)).toBe(false);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('returns false for a non-existent path (does not throw)', async () => {
    expect(await discordOpsAdapter.detect('C:/this/path/should/not/exist/anywhere')).toBe(false);
  });

  it('returns false when package.json matches but no defineTool/category file exists', async () => {
    // Multi-signal detection: name alone isn't enough. Build a temp
    // directory with a discord-ops-named package.json but no source files -
    // detect() must reject because the content signal is missing.
    const dir = mkdtempSync(join(tmpdir(), 'discord-ops-detect-namelyok-'));
    try {
      writeFileSync(
        join(dir, 'package.json'),
        JSON.stringify({ name: 'discord-ops', version: '0.0.0' }),
        'utf8',
      );
      expect(await discordOpsAdapter.detect(dir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns false when package.json name does not match (even with defineTool + category)', async () => {
    // Inverse case: a TypeScript repo that happens to use the
    // `defineTool({ category: ... })` pattern but isn't discord-ops must
    // NOT trigger detect(). The name guard MUST short-circuit first.
    const dir = mkdtempSync(join(tmpdir(), 'discord-ops-detect-namemismatch-'));
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
        "export const x = defineTool({ name: 'foo', category: 'bar' });",
        'utf8',
      );
      expect(await discordOpsAdapter.detect(dir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns false when defineTool exists but no category field is present', async () => {
    // Both signals required: defineTool + category. A repo with only
    // defineTool but no category should fail.
    const dir = mkdtempSync(join(tmpdir(), 'discord-ops-detect-nocategory-'));
    try {
      writeFileSync(
        join(dir, 'package.json'),
        JSON.stringify({ name: 'discord-ops', version: '0.0.0' }),
        'utf8',
      );
      const tools = join(dir, 'src', 'tools');
      mkdirSync(tools, { recursive: true });
      writeFileSync(join(tools, 't.ts'), "export const x = defineTool({ name: 'foo' });", 'utf8');
      expect(await discordOpsAdapter.detect(dir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('discordOpsAdapter - 4-way cross-detection', () => {
  // discord-ops's detect() MUST reject every other adapter's fixture.
  it('returns false on the PaSympa fixture (cross-detection)', async () => {
    // PaSympa's package.json is `@pasympa/discord-mcp` - does not match
    // /discord[-_]ops/. Even if the content signal hit, the name guard
    // short-circuits.
    expect(await discordOpsAdapter.detect(PASYMPA_FIXTURE_ROOT)).toBe(false);
  });

  it('returns false on the quadslab fixture (cross-detection)', async () => {
    // quadslab's package.json is `@quadslab.io/discord-mcp` - name guard
    // rejects. Content also lacks `defineTool(` / `category:` fields.
    expect(await discordOpsAdapter.detect(QUADSLAB_FIXTURE_ROOT)).toBe(false);
  });

  it('returns false on the Hubdustry fixture (cross-detection, no package.json)', async () => {
    // Hubdustry fixture has no package.json at all (it's a Go repo) -
    // the name-guard try/catch must return false on the read error.
    expect(await discordOpsAdapter.detect(HUBDUSTRY_FIXTURE_ROOT)).toBe(false);
  });

  // Inverse: every other adapter's detect() MUST reject discord-ops's fixture.
  it('PaSympa.detect() returns false on the discord-ops fixture (inverse)', async () => {
    // PaSympa requires `pasympa` in the package.json name - discord-ops
    // package name is `discord-ops` and doesn't contain `pasympa`. PaSympa
    // also requires `'discord_*'` literals, which the discord-ops fixture
    // doesn't ship.
    expect(await pasympaAdapter.detect(FIXTURE_ROOT)).toBe(false);
  });

  it('quadslab.detect() returns false on the discord-ops fixture (inverse)', async () => {
    // quadslab requires `quadslab` in the package.json name. The
    // discord-ops fixture doesn't ship `<x>Tools` / `execute<X>Tool`
    // either, but the name guard short-circuits first.
    expect(await quadslabAdapter.detect(FIXTURE_ROOT)).toBe(false);
  });

  it('Hubdustry.detect() returns false on the discord-ops fixture (inverse)', async () => {
    // Hubdustry expects `main.go` at root or under `apps/mcp/`. The
    // discord-ops fixture is pure TypeScript - no Go files anywhere.
    expect(await hubdustryGoMcpAdapter.detect(FIXTURE_ROOT)).toBe(false);
  });
});

describe('discordOpsAdapter - migrate()', () => {
  it('reports 6 mapped tools and 2 unmapped tools against the fixture', async () => {
    const result = await discordOpsAdapter.migrate(FIXTURE_ROOT);
    expect(result.source).toBe('discord-ops');
    expect(result.sourcePath).toBe(FIXTURE_ROOT);
    expect(result.manualReview.length).toBe(0);
    // 8 fixture tools total: 6 in NAME_MAP (5 standard + 1 profile-variant
    // alias), 2 intentional unmapped (system).
    const all = [...result.mappedTools.map((t) => t.original), ...result.unmappedTools];
    expect(all.sort()).toEqual(
      [
        'edit_message',
        'get_messages',
        'health_check',
        'list_channels',
        'list_projects',
        'messages_lite',
        'send_message',
        'set_slowmode',
      ].sort(),
    );
    expect(result.mappedTools.length).toBe(6);
    expect(result.unmappedTools.length).toBe(2);
    expect(result.unmappedTools).toContain('health_check');
    expect(result.unmappedTools).toContain('list_projects');
  });

  it('maps the five known tools to their discord-mcp equivalents', async () => {
    const result = await discordOpsAdapter.migrate(FIXTURE_ROOT);
    const byOriginal = new Map(result.mappedTools.map((t) => [t.original, t]));
    expect(byOriginal.get('send_message')?.mapped).toBe('messages_send');
    expect(byOriginal.get('get_messages')?.mapped).toBe('messages_read');
    expect(byOriginal.get('edit_message')?.mapped).toBe('messages_edit');
    expect(byOriginal.get('list_channels')?.mapped).toBe('channels_list');
    expect(byOriginal.get('set_slowmode')?.mapped).toBe('channels_modify');
    // Every mapped tool must carry one of the three confidence levels.
    for (const tool of result.mappedTools) {
      expect(['high', 'medium', 'low']).toContain(tool.confidence);
    }
  });

  it('flags 1:1 message/channel tools as high-confidence', async () => {
    const result = await discordOpsAdapter.migrate(FIXTURE_ROOT);
    const byOriginal = new Map(result.mappedTools.map((t) => [t.original, t]));
    expect(byOriginal.get('send_message')?.confidence).toBe('high');
    expect(byOriginal.get('get_messages')?.confidence).toBe('high');
    expect(byOriginal.get('edit_message')?.confidence).toBe('high');
    expect(byOriginal.get('list_channels')?.confidence).toBe('high');
  });

  it('flags set_slowmode as medium-confidence with a note about channels_modify', async () => {
    const result = await discordOpsAdapter.migrate(FIXTURE_ROOT);
    const byOriginal = new Map(result.mappedTools.map((t) => [t.original, t]));
    expect(byOriginal.get('set_slowmode')?.confidence).toBe('medium');
    expect(byOriginal.get('set_slowmode')?.notes).toContain('rate_limit_per_user');
  });

  it('maps the messages_lite profile variant onto messages_send with medium confidence + note', async () => {
    // Critical architectural-mismatch assertion (Phase D Task D.2 special
    // handling): profile variants collapse onto the same discord-mcp tool
    // with medium confidence, and the note must explain that discord-mcp
    // ships the full surface and the agent filters at runtime.
    const result = await discordOpsAdapter.migrate(FIXTURE_ROOT);
    const byOriginal = new Map(result.mappedTools.map((t) => [t.original, t]));
    const lite = byOriginal.get('messages_lite');
    expect(lite).toBeDefined();
    expect(lite?.mapped).toBe('messages_send');
    expect(lite?.confidence).toBe('medium');
    expect(lite?.notes).toContain('profile-variant');
    expect(lite?.notes).toContain('agent filters at runtime');
  });

  it('emits architectural-mismatch warnings on a non-empty migration', async () => {
    // Per the file header "## Architectural mismatches" section, the
    // adapter ALWAYS emits three warnings on a non-empty run covering
    // multi-guild routing, tool profiles, and dry-run env-var renaming.
    const result = await discordOpsAdapter.migrate(FIXTURE_ROOT);
    expect(result.warnings.some((w) => w.includes('multi-guild'))).toBe(true);
    expect(result.warnings.some((w) => w.includes('tool profiles'))).toBe(true);
    expect(
      result.warnings.some((w) => w.includes('MCP_DRY_RUN') || w.includes('DISCORD_OPS_DRY_RUN')),
    ).toBe(true);
  });

  it('emits a "no discord-ops tool names found" warning for an empty source dir', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'discord-ops-migrate-empty-'));
    try {
      const result = await discordOpsAdapter.migrate(empty);
      expect(result.mappedTools.length).toBe(0);
      expect(result.unmappedTools.length).toBe(0);
      expect(result.warnings.some((w) => w.includes('no discord-ops tool names found'))).toBe(true);
      // Architectural-mismatch warnings should NOT appear on an empty
      // run - there's nothing to warn about. The early-exit ensures the
      // user isn't spammed when running against the wrong directory.
      expect(result.warnings.some((w) => w.includes('multi-guild'))).toBe(false);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
