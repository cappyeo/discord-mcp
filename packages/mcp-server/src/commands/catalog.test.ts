import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../transports/catalog.js', () => ({
  startCatalog: vi.fn(async () => {}),
}));
vi.mock('./catalog-check.js', () => ({
  runCatalogCheck: vi.fn(async () => ({
    schema_version: 'discord-mcp.catalog-check.v1',
    tool_count: 208,
    resource_count: 6,
    execution_guard: 'CATALOG_ONLY',
    credentials_required: false,
    discord_execution: 'disabled',
    activity_evidence_created: false,
  })),
}));

const { catalogAction } = await import('./catalog.js');
const { startCatalog } = await import('../transports/catalog.js');
const { runCatalogCheck } = await import('./catalog-check.js');

const originalExitCode = process.exitCode;

describe('catalogAction', () => {
  beforeEach(() => {
    vi.mocked(startCatalog).mockClear();
    vi.mocked(runCatalogCheck).mockClear();
    vi.mocked(runCatalogCheck).mockResolvedValue({
      schema_version: 'discord-mcp.catalog-check.v1',
      tool_count: 208,
      resource_count: 6,
      execution_guard: 'CATALOG_ONLY',
      credentials_required: false,
      discord_execution: 'disabled',
      activity_evidence_created: false,
    });
    process.exitCode = 0;
  });

  afterEach(() => {
    process.exitCode = originalExitCode;
  });

  it('starts the catalog transport without options or credential setup', async () => {
    await catalogAction();
    expect(startCatalog).toHaveBeenCalledTimes(1);
    expect(startCatalog).toHaveBeenCalledWith();
    expect(process.exitCode).toBe(0);
  });

  it('reports startup failures to stderr and sets a nonzero exit code', async () => {
    vi.mocked(startCatalog).mockRejectedValueOnce(new Error('catalog boom'));
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      await catalogAction();
      expect(process.exitCode).toBe(1);
      expect(stderr).toHaveBeenCalledWith('discord-mcp catalog failed to start: catalog boom\n');
    } finally {
      stderr.mockRestore();
    }
  });

  it('runs the bounded check instead of starting stdio and emits machine-readable data', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await catalogAction({ check: true, json: true });
      expect(runCatalogCheck).toHaveBeenCalledTimes(1);
      expect(startCatalog).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(0);
      const output = stdout.mock.calls.map(([chunk]) => String(chunk)).join('');
      expect(JSON.parse(output)).toMatchObject({
        ok: true,
        summary: 'Credential-free MCP catalog check passed',
        data: {
          schema_version: 'discord-mcp.catalog-check.v1',
          tool_count: 208,
          resource_count: 6,
          execution_guard: 'CATALOG_ONLY',
          credentials_required: false,
          discord_execution: 'disabled',
          activity_evidence_created: false,
        },
        exitCode: 0,
      });
    } finally {
      stdout.mockRestore();
    }
  });

  it('fails closed when the catalog contract check fails', async () => {
    vi.mocked(runCatalogCheck).mockRejectedValueOnce(new Error('catalog contract mismatch'));
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await catalogAction({ check: true, json: true });
      expect(startCatalog).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(2);
      expect(JSON.parse(stdout.mock.calls.map(([chunk]) => String(chunk)).join(''))).toMatchObject({
        ok: false,
        summary: 'Credential-free MCP catalog check failed',
        errors: ['catalog contract mismatch'],
        exitCode: 2,
      });
    } finally {
      stdout.mockRestore();
    }
  });

  it('rejects JSON mode without the bounded check', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await catalogAction({ json: true });
      expect(runCatalogCheck).not.toHaveBeenCalled();
      expect(startCatalog).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(2);
      expect(JSON.parse(stdout.mock.calls.map(([chunk]) => String(chunk)).join(''))).toMatchObject({
        ok: false,
        summary: 'Catalog JSON output requires --check',
        exitCode: 2,
      });
    } finally {
      stdout.mockRestore();
    }
  });
});
