import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileGrantStore, type Grant, MemoryGrantStore } from './oauth-grant-store.js';

const NOW = Date.parse('2026-11-02T00:00:00.000Z');

const granted = (expiresAt = NOW + 3_600_000): Grant => ({
  userId: '111122223333444455',
  username: 'caller',
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
    // Restore permissions so cleanup can remove read-only fixtures.
    try {
      chmodSync(directory, 0o700);
    } catch {
      // ignore
    }
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

  it('keeps working when the state directory is not writable', () => {
    // The deploy regression: the named volume mounted root-owned, the container
    // runs as uid 1000, and a failed write surfaced as HTTP 500 on /token.
    const parent = temporaryDirectory();
    const readOnly = join(parent, 'readonly');
    mkdirSync(readOnly, { mode: 0o500 });
    const warnings: string[] = [];
    const store = new FileGrantStore(
      readOnly,
      () => NOW,
      (message) => warnings.push(message),
    );

    // The grant is still usable for this process; only persistence failed.
    expect(() => store.set('token-a', granted())).not.toThrow();
    expect(store.get('token-a')?.userId).toBe('111122223333444455');
    expect(warnings.join(' ')).toMatch(/will not survive a restart|will not persist/u);
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
