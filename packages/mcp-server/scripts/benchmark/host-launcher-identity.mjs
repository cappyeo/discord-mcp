import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

import { sameFileIdentity } from './file-identity.mjs';
import { canonicalJson } from './manifest.mjs';

export const HOST_LAUNCHER_IDENTITY_SCHEMA = 'discord-mcp.host-launcher-identity.v1';

const MAX_LAUNCHER_FILE_BYTES = 512 * 1024 * 1024;
const READ_BUFFER_BYTES = 1024 * 1024;
const NATIVE_KINDS = new Set(['binary', 'native', 'native-sibling']);
const POWERSHELL_PREFIX = Object.freeze([
  '-NoLogo',
  '-NoProfile',
  '-NonInteractive',
  '-ExecutionPolicy',
  'Bypass',
  '-File',
]);

function record(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, expected) {
  return (
    record(value) &&
    Object.keys(value).sort().join('\0') === [...expected].sort().join('\0')
  );
}

function fileUnchanged(before, after, platform) {
  return (
    after.isFile() &&
    before.size === after.size &&
    before.mtimeMs === after.mtimeMs &&
    before.ctimeMs === after.ctimeMs &&
    sameFileIdentity(before, after, platform)
  );
}

async function hashRegularFile(path, { executable, platform }) {
  if (typeof path !== 'string' || !isAbsolute(path))
    throw new TypeError('host launcher file must use an absolute path');
  const requested = await lstat(path).catch(() => null);
  if (requested === null || requested.isSymbolicLink())
    throw new Error('host launcher file must be a non-symlink regular file');
  if (!requested.isFile()) throw new Error('host launcher file must be a regular file');
  const canonical = resolve(await realpath(path));
  const initial = await lstat(canonical);
  if (initial.isSymbolicLink() || !initial.isFile())
    throw new Error('host launcher file must be a non-symlink regular file');
  if (initial.size < 1 || initial.size > MAX_LAUNCHER_FILE_BYTES)
    throw new Error('host launcher file is outside the size bound');
  if (executable && platform !== 'win32' && (initial.mode & 0o111) === 0)
    throw new Error('host launcher executable is not executable');

  let handle;
  try {
    handle = await open(canonical, fsConstants.O_RDONLY);
    const before = await handle.stat();
    if (!fileUnchanged(initial, before, platform))
      throw new Error('host launcher file changed during attestation');
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(READ_BUFFER_BYTES);
    let position = 0;
    while (position < before.size) {
      const length = Math.min(buffer.length, before.size - position);
      const { bytesRead } = await handle.read(buffer, 0, length, position);
      if (bytesRead < 1) throw new Error('host launcher file changed during attestation');
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const after = await handle.stat();
    const final = await lstat(canonical);
    if (!fileUnchanged(before, after, platform) || !fileUnchanged(initial, final, platform))
      throw new Error('host launcher file changed during attestation');
    return `sha256:${hash.digest('hex')}`;
  } finally {
    await handle?.close();
  }
}

function launcherFiles(launcher) {
  if (!exactKeys(launcher, new Set(['command', 'kind', 'prefix_args'])))
    throw new TypeError('host launcher has invalid fields');
  if (typeof launcher.command !== 'string' || !Array.isArray(launcher.prefix_args))
    throw new TypeError('host launcher is invalid');
  if (NATIVE_KINDS.has(launcher.kind)) {
    if (launcher.prefix_args.length !== 0)
      throw new TypeError('native host launcher cannot contain prefix arguments');
    return [{ path: launcher.command, role: 'executable', executable: true }];
  }
  if (launcher.kind === 'node') {
    if (launcher.prefix_args.length !== 1 || typeof launcher.prefix_args[0] !== 'string')
      throw new TypeError('Node host launcher must contain one entrypoint');
    return [
      { path: launcher.command, role: 'executable', executable: true },
      { path: launcher.prefix_args[0], role: 'entrypoint', executable: false },
    ];
  }
  if (launcher.kind === 'powershell') {
    if (
      launcher.prefix_args.length !== POWERSHELL_PREFIX.length + 1 ||
      POWERSHELL_PREFIX.some((argument, index) => launcher.prefix_args[index] !== argument) ||
      typeof launcher.prefix_args.at(-1) !== 'string'
    ) {
      throw new TypeError('PowerShell host launcher has an invalid execution graph');
    }
    return [
      { path: launcher.command, role: 'executable', executable: true },
      { path: launcher.prefix_args.at(-1), role: 'entrypoint', executable: false },
    ];
  }
  throw new TypeError('host launcher kind is unsupported');
}

/**
 * Bind a launch graph to local file bytes without publishing local paths.
 * This proves stable executable identity, not vendor authenticity or code signing.
 */
export async function attestHostLauncher(launcher, { platform = process.platform } = {}) {
  const files = [];
  for (const file of launcherFiles(launcher)) {
    files.push({
      role: file.role,
      sha256: await hashRegularFile(file.path, { executable: file.executable, platform }),
    });
  }
  const payload = {
    schema_version: HOST_LAUNCHER_IDENTITY_SCHEMA,
    kind: launcher.kind,
    files,
  };
  return {
    schema_version: HOST_LAUNCHER_IDENTITY_SCHEMA,
    kind: launcher.kind,
    digest: `sha256:${createHash('sha256').update(canonicalJson(payload), 'utf8').digest('hex')}`,
  };
}
