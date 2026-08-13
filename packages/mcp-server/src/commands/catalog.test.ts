import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../transports/catalog.js', () => ({
  startCatalog: vi.fn(async () => {}),
}));

const { catalogAction } = await import('./catalog.js');
const { startCatalog } = await import('../transports/catalog.js');

const originalExitCode = process.exitCode;

describe('catalogAction', () => {
  beforeEach(() => {
    vi.mocked(startCatalog).mockClear();
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
});
