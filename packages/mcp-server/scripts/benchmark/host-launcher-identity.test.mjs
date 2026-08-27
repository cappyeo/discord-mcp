import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { attestHostLauncher, HOST_LAUNCHER_IDENTITY_SCHEMA } from './host-launcher-identity.mjs';

const roots = [];

async function executable(root, name, contents) {
  const path = join(root, name);
  await writeFile(path, contents);
  if (process.platform !== 'win32') await chmod(path, 0o700);
  return path;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('host launcher byte identity', () => {
  it('attests a native executable without exposing its local path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'discord-mcp-launcher-'));
    roots.push(root);
    const command = await executable(root, 'host-cli', 'native-v1');

    const identity = await attestHostLauncher({
      command,
      prefix_args: [],
      kind: 'native',
    });

    expect(identity).toEqual({
      schema_version: HOST_LAUNCHER_IDENTITY_SCHEMA,
      kind: 'native',
      digest: 'sha256:da486672f91c065e1a2097def18e2468edc0091c6b70e4e94a6aad381e8685fe',
    });
    expect(JSON.stringify(identity)).not.toContain(root);
  });

  it('binds both the runtime and entrypoint for a Node launcher', async () => {
    const root = await mkdtemp(join(tmpdir(), 'discord-mcp-launcher-'));
    roots.push(root);
    const command = await executable(root, 'node-runtime', 'runtime-v1');
    const entrypoint = await executable(root, 'host.mjs', 'entrypoint-v1');
    const launcher = { command, prefix_args: [entrypoint], kind: 'node' };

    const first = await attestHostLauncher(launcher);
    await writeFile(entrypoint, 'entrypoint-v2');
    const changed = await attestHostLauncher(launcher);

    expect(changed.digest).not.toBe(first.digest);
  });

  it('rejects relative, malformed, and unsupported launch graphs', async () => {
    await expect(
      attestHostLauncher({ command: 'host-cli', prefix_args: [], kind: 'native' }),
    ).rejects.toThrow(/absolute/iu);
    await expect(
      attestHostLauncher({ command: 'host-cli', prefix_args: [], kind: 'unknown' }),
    ).rejects.toThrow(/kind/iu);
    await expect(
      attestHostLauncher({
        command: 'powershell.exe',
        prefix_args: ['-File', 'relative.ps1'],
        kind: 'powershell',
      }),
    ).rejects.toThrow();
  });

  it.skipIf(process.platform === 'win32')('rejects a symlinked executable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'discord-mcp-launcher-'));
    roots.push(root);
    const target = await executable(root, 'target', 'native-v1');
    const command = join(root, 'launcher');
    await symlink(target, command);

    await expect(attestHostLauncher({ command, prefix_args: [], kind: 'native' })).rejects.toThrow(
      /symlink/iu,
    );
  });
});
