import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileGrantStore, type Grant, MemoryGrantStore } from './oauth-grant-store.js';

const NOW = Date.parse('2026-11-02T00:00:00.000Z');

const granted = (expiresAt = NOW + 3_600_000): Grant => ({
  userId: '111122223333444455',
  clientId: 'mcp-client',
  scope: 'identify',
  expiresAt,
});

const directories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'discord-mcp-grants-'));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('grant stores', () => {
  it('expires memory grants on read', () => {
    let now = NOW;
    const store = new MemoryGrantStore(() => now);
    store.set('token-a', granted());

    expect(store.get('token-a')?.userId).toBe('111122223333444455');
    now = NOW + 3_600_001;
    expect(store.get('token-a')).toBeUndefined();
  });

  it('survives a process restart', () => {
    // The regression: a deploy restarted the container and every client's
    // token vanished, forcing a fresh OAuth round trip.
    const directory = temporaryDirectory();
    new FileGrantStore(directory, () => NOW).set('token-a', granted());

    // A second instance is what a restarted process sees.
    expect(new FileGrantStore(directory, () => NOW).get('token-a')).toEqual(granted());
  });

  it('writes the grant file owner-only', () => {
    const directory = temporaryDirectory();
    new FileGrantStore(directory, () => NOW).set('token-a', granted());

    // Bearer material: group/other must have no access.
    expect(statSync(join(directory, 'oauth-grants.json')).mode & 0o077).toBe(0);
  });

  it('does not resurrect expired grants across a restart', () => {
    const directory = temporaryDirectory();
    new FileGrantStore(directory, () => NOW).set('token-a', granted());

    expect(new FileGrantStore(directory, () => NOW + 3_600_001).get('token-a')).toBeUndefined();
  });

  it('starts empty when the file is corrupt instead of refusing to boot', () => {
    const directory = temporaryDirectory();
    new FileGrantStore(directory, () => NOW).set('token-a', granted());
    writeFileSync(join(directory, 'oauth-grants.json'), '{not json');

    const restarted = new FileGrantStore(directory, () => NOW);
    expect(restarted.get('token-a')).toBeUndefined();
    // Still usable afterwards.
    restarted.set('token-b', granted());
    expect(restarted.get('token-b')).toBeDefined();
  });
});
