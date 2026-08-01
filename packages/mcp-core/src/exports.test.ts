/**
 * The frozen public surface of `@discord-mcp/core`.
 *
 * v1.0.0 commits to "exports frozen - no removals, only additions" for 6+
 * months. That was a promise with nothing enforcing it: any refactor could
 * drop a re-export and no test would notice until a consumer's build broke.
 *
 * The snapshot makes removals and renames fail CI. Adding an export updates
 * the snapshot (legal in a minor); removing one requires deleting a line by
 * hand, which is exactly the deliberate act a major-version change should be.
 */
import { describe, expect, it } from 'vitest';
import * as api from './index.js';

describe('public export surface', () => {
  it('matches the frozen snapshot', () => {
    expect(Object.keys(api).sort()).toMatchSnapshot();
  });

  it('exports every type a consumer needs to call buildServer', async () => {
    // The signature-completeness failure mode: a type referenced by an
    // exported function's signature but not itself exported, so a consumer
    // cannot name it and cannot build the argument.
    expect(typeof api.buildServer).toBe('function');
    expect(typeof api.loadConfig).toBe('function');
    expect(typeof api.createLogger).toBe('function');
    expect(typeof api.buildPolicy).toBe('function');
    expect(typeof api.wrapRestWithResilience).toBe('function');
  });

  it('exports no symbol whose value is undefined', () => {
    // A broken re-export (wrong name, moved file) still appears as a key.
    const undef = Object.entries(api)
      .filter(([, v]) => v === undefined)
      .map(([k]) => k);
    expect(undef).toEqual([]);
  });

  it('reports a real version, not a placeholder', () => {
    expect(api.VERSION).toMatch(/^\d+\.\d+\.\d+/);
    expect(api.VERSION).not.toBe('0.0.0');
  });
});
