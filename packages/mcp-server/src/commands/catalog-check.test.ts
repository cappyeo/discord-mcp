import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCatalogCheck } from './catalog-check.js';

const savedEnv = { ...process.env };

describe('runCatalogCheck', () => {
  beforeEach(() => {
    process.env.DISCORD_TOKEN = 'ambient-token-that-must-not-be-read';
    process.env.GATEWAY = 'true';
    process.env.OTEL_ENABLED = 'true';
    process.env.MCP_CATEGORIES = 'not-a-real-category';
  });

  afterEach(() => {
    process.env = { ...savedEnv };
    vi.restoreAllMocks();
  });

  it('verifies the complete packaged catalog without credentials or network access', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    await expect(runCatalogCheck()).resolves.toEqual({
      schema_version: 'discord-mcp.catalog-check.v1',
      tool_count: 209,
      resource_count: 6,
      execution_guard: 'CATALOG_ONLY',
      credentials_required: false,
      discord_execution: 'disabled',
      activity_evidence_created: false,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
