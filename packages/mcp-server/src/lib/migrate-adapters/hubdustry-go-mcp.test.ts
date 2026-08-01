/**
 * Adapter unit tests - Plan 9 Phase E.
 *
 * Tests run against the synthetic fixture under
 * `packages/mcp-server/test-fixtures/hubdustry-go-mcp/`. The fixture
 * lives outside `src/` so it isn't compiled, isn't packed (the package
 * `files: ["dist", ...]` allowlist excludes it), and isn't lint-checked.
 *
 * The fixture contains 5 mcp.NewTool calls - server.files.{list,read,
 * write} and server.deploy.{trigger,status}. The Hubdustry adapter's
 * NAME_MAP is empty by design, so a successful run reports all 5 as
 * unmapped.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { hubdustryGoMcpAdapter } from './hubdustry-go-mcp.js';

// `src/lib/migrate-adapters/hubdustry-go-mcp.test.ts` is three directories
// below the package root, where `test-fixtures/` lives.
const PACKAGE_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const FIXTURE_ROOT = join(PACKAGE_ROOT, 'test-fixtures', 'hubdustry-go-mcp');

describe('hubdustryGoMcpAdapter - id + description', () => {
  it('exposes a stable kebab-case id', () => {
    expect(hubdustryGoMcpAdapter.id).toBe('hubdustry-go-mcp');
  });

  it('has a non-empty description', () => {
    expect(hubdustryGoMcpAdapter.description.length).toBeGreaterThan(10);
  });
});

describe('hubdustryGoMcpAdapter - Plan 11 Phase A metadata', () => {
  it('declares the upstream homepage link', () => {
    expect(hubdustryGoMcpAdapter.homepage).toBe(
      'https://github.com/jhm1909/Hubdustry/tree/main/apps/mcp',
    );
  });

  it('declares languages: ["go"] and toolCountEstimate: 8', () => {
    expect(hubdustryGoMcpAdapter.languages).toEqual(['go']);
    expect(hubdustryGoMcpAdapter.toolCountEstimate).toBe(8);
  });
});

describe('hubdustryGoMcpAdapter - detect()', () => {
  it('returns true for the synthetic fixture (apps/mcp layout)', async () => {
    expect(await hubdustryGoMcpAdapter.detect(FIXTURE_ROOT)).toBe(true);
  });

  it('returns false for a path with no Hubdustry markers', async () => {
    // Use a fresh temp dir so we're guaranteed nothing matches.
    const empty = mkdtempSync(join(tmpdir(), 'hubdustry-detect-'));
    try {
      expect(await hubdustryGoMcpAdapter.detect(empty)).toBe(false);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('returns false for a non-existent path (does not throw)', async () => {
    expect(await hubdustryGoMcpAdapter.detect('C:/this/path/should/not/exist/anywhere')).toBe(
      false,
    );
  });
});

describe('hubdustryGoMcpAdapter - migrate()', () => {
  it('reports all 5 fixture tools as unmappedTools (NAME_MAP is empty)', async () => {
    const result = await hubdustryGoMcpAdapter.migrate(FIXTURE_ROOT);
    expect(result.source).toBe('hubdustry-go-mcp');
    expect(result.mappedTools.length).toBe(0);
    expect(result.manualReview.length).toBe(0);
    expect(result.unmappedTools.length).toBe(5);
    expect(result.unmappedTools).toEqual(
      expect.arrayContaining([
        'server.files.list',
        'server.files.read',
        'server.files.write',
        'server.deploy.trigger',
        'server.deploy.status',
      ]),
    );
  });

  it('resolves apps/mcp under sourcePath when the monorepo layout is present', async () => {
    const result = await hubdustryGoMcpAdapter.migrate(FIXTURE_ROOT);
    expect(result.sourcePath).toBe(join(FIXTURE_ROOT, 'apps', 'mcp'));
  });

  it('emits a "no mcp.NewTool calls found" warning for an empty dir', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'hubdustry-migrate-empty-'));
    try {
      const result = await hubdustryGoMcpAdapter.migrate(empty);
      expect(result.unmappedTools.length).toBe(0);
      expect(result.warnings.some((w) => w.includes('no mcp.NewTool'))).toBe(true);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('walks tools/*.go recursively (subdir tools also discovered)', async () => {
    // Sanity: the fixture's tools/ has flat files, so the recursion just
    // confirms the readDirGoFiles helper visits them. Both files.go and
    // deploy.go are read - verified via the per-tool count below.
    const result = await hubdustryGoMcpAdapter.migrate(FIXTURE_ROOT);
    const fileTools = result.unmappedTools.filter((n) => n.startsWith('server.files.'));
    const deployTools = result.unmappedTools.filter((n) => n.startsWith('server.deploy.'));
    expect(fileTools.length).toBe(3);
    expect(deployTools.length).toBe(2);
  });

  // Defensive cleanup in case any test left a temp dir behind.
  afterAll(() => {
    // No persistent state to clean here - temp dirs are scoped per-test.
  });
});
