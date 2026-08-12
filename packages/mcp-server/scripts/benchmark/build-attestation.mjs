import { execFile as nodeExecFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, open, readdir, realpath, rm, rmdir } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

import { assertBenchmarkSourceIntegrity } from './source-integrity.mjs';

const execFile = promisify(nodeExecFile);
const ENTRYPOINT = 'packages/mcp-server/dist/cli.js';
const OUTPUT_DIRECTORY = 'packages/mcp-server/dist';
const CORE_ENTRYPOINT = 'packages/mcp-core/dist/index.js';
const CORE_OUTPUT_DIRECTORY = 'packages/mcp-core/dist';
const MAX_CLI_BYTES = 50 * 1024 * 1024;
const MAX_GRAPH_FILES = 256;
const MAX_GRAPH_TOTAL_BYTES = 100 * 1024 * 1024;
const JS_BASENAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.js$/;

export async function buildBenchmarkCli({ cwd, execFile: run = execFile } = {}) {
  if (typeof run !== 'function') throw new TypeError('execFile must be a function');
  const options = { cwd, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024, windowsHide: true };
  const invoke = (pnpmArgs) =>
    process.platform === 'win32'
      ? [process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'pnpm.cmd', ...pnpmArgs]]
      : ['pnpm', pnpmArgs];
  try {
    for (const pnpmArgs of [
      ['--filter', '@discord-mcp/core', 'build'],
      ['--filter', '@discord-mcp/cli', 'build'],
    ]) {
      const [command, args] = invoke(pnpmArgs);
      await run(command, args, options);
    }
  } catch {
    throw new Error('benchmark CLI build failed');
  }
}

function isWithin(root, target) {
  const path = relative(root, target);
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}

async function clearOutputDirectory(cwd, outputDirectory = OUTPUT_DIRECTORY) {
  const root = await realpath(cwd);
  const output = resolve(cwd, outputDirectory);
  let metadata;
  try {
    metadata = await lstat(output);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  if (metadata.isSymbolicLink())
    throw new Error('built CLI output directory must not be a symlink');
  const actual = await realpath(output);
  if (!isWithin(root, actual)) throw new Error('built CLI output directory escaped the repository');
  await rm(actual, { recursive: true, force: true });
}

export async function attestBuiltCli({
  cwd,
  expectedCommit,
  build = buildBenchmarkCli,
  sourceIntegrity = assertBenchmarkSourceIntegrity,
} = {}) {
  if (typeof build !== 'function') throw new TypeError('build must be a function');
  if (typeof sourceIntegrity !== 'function') {
    throw new TypeError('sourceIntegrity must be a function');
  }

  await sourceIntegrity({ cwd, expectedCommit });
  await clearOutputDirectory(cwd);
  await clearOutputDirectory(cwd, CORE_OUTPUT_DIRECTORY);
  await build({ cwd });
  const source = await sourceIntegrity({ cwd, expectedCommit });

  const root = await realpath(cwd);
  const cli = await hashVerifiedArtifact({ root, entrypoint: ENTRYPOINT, label: 'built CLI' });
  const cliGraph = await attestOutputGraph({
    root,
    outputDirectory: OUTPUT_DIRECTORY,
    label: 'built CLI',
  });
  const coreGraph = await attestOutputGraph({
    root,
    outputDirectory: CORE_OUTPUT_DIRECTORY,
    label: 'built core',
  });
  const cliEntry = cliGraph.files.find((file) => file.path === ENTRYPOINT);
  const coreEntry = coreGraph.files.find((file) => file.path === CORE_ENTRYPOINT);
  if (!cliEntry || cliEntry.sha256 !== cli.sha256) {
    throw new Error('built CLI entrypoint is not bound to the attested file graph');
  }
  if (!coreEntry) {
    throw new Error('built core entrypoint is not bound to the attested file graph');
  }
  const snapshot = await createRuntimeSnapshot({
    root,
    cliFiles: cliGraph.files,
    coreFiles: coreGraph.files,
  });
  return {
    attestation: {
      entrypoint: ENTRYPOINT,
      sha256: cliEntry.sha256,
      source_commit: source.commit,
      core_entrypoint: CORE_ENTRYPOINT,
      core_sha256: coreEntry.sha256,
      core_source_commit: source.commit,
      files: cliGraph.files.map(({ path, sha256 }) => ({ path, sha256 })),
      core_files: coreGraph.files.map(({ path, sha256 }) => ({ path, sha256 })),
    },
    cliPath: snapshot.cliPath,
    corePath: snapshot.corePath,
    cleanup: snapshot.cleanup,
    allowedUntracked: source.allowed_untracked,
  };
}

async function resolveBuiltArtifact(root, entrypoint, label) {
  const candidate = resolve(root, entrypoint);
  await assertNoSymlinkPath(candidate, label);
  const candidateMetadata = await lstat(candidate);
  if (candidateMetadata.isSymbolicLink())
    throw new Error(`${label} entrypoint must not be a symlink`);
  if (
    !candidateMetadata.isFile() ||
    candidateMetadata.size < 1 ||
    candidateMetadata.size > MAX_CLI_BYTES
  ) {
    throw new Error(`${label} artifact is missing or outside the size bound`);
  }
  const path = await realpath(candidate);
  if (!isWithin(root, path)) throw new Error(`${label} resolves outside the source repository`);
  await assertNoSymlinkPath(path, label);
  return { path, metadata: candidateMetadata };
}

async function assertNoSymlinkPath(path, label) {
  let current = resolve(path);
  while (true) {
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        throw new Error(`${label} contains a symlink`);
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    const parent = resolve(current, '..');
    if (parent === current) return;
    current = parent;
  }
}

async function hashVerifiedArtifact({ root, entrypoint, label }) {
  const resolved = await resolveBuiltArtifact(root, entrypoint, label);
  const noFollow = Number.isInteger(fsConstants.O_NOFOLLOW) ? fsConstants.O_NOFOLLOW : 0;
  const handle = await open(resolved.path, fsConstants.O_RDONLY | noFollow);
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.dev !== resolved.metadata.dev ||
      opened.ino !== resolved.metadata.ino ||
      opened.size !== resolved.metadata.size
    ) {
      throw new Error(`${label} changed while opening`);
    }
    const hash = createHash('sha256');
    const chunks = [];
    const buffer = Buffer.alloc(64 * 1024);
    let total = 0;
    while (true) {
      const read = await handle.read(buffer, 0, buffer.length, null);
      if (read.bytesRead === 0) break;
      const chunk = buffer.subarray(0, read.bytesRead);
      total += read.bytesRead;
      if (total > MAX_CLI_BYTES) throw new Error(`${label} is outside the size bound`);
      hash.update(chunk);
      chunks.push(Buffer.from(chunk));
    }
    const final = await handle.stat();
    if (
      !final.isFile() ||
      final.dev !== resolved.metadata.dev ||
      final.ino !== resolved.metadata.ino ||
      final.size !== total ||
      total < 1
    ) {
      throw new Error(`${label} changed while reading`);
    }
    return {
      path: resolved.path,
      bytes: Buffer.concat(chunks, total),
      sha256: `sha256:${hash.digest('hex')}`,
    };
  } finally {
    await handle.close();
  }
}

function toPosixPath(path) {
  return path.split(sep).join('/');
}

async function attestOutputGraph({ root, outputDirectory, label }) {
  const directory = resolve(root, outputDirectory);
  await assertNoSymlinkPath(directory, `${label} output directory`);
  const directoryMetadata = await lstat(directory);
  if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink()) {
    throw new Error(`${label} output directory is not a regular directory`);
  }
  const entries = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.name.endsWith('.js'))
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  if (entries.length < 1 || entries.length > MAX_GRAPH_FILES) {
    throw new Error(`${label} JavaScript graph has an invalid file count`);
  }
  let totalBytes = 0;
  const files = [];
  for (const entry of entries) {
    if (!JS_BASENAME_RE.test(entry.name) || entry.isSymbolicLink() || !entry.isFile()) {
      throw new Error(`${label} graph contains an invalid JavaScript entry`);
    }
    const relativeEntry = toPosixPath(join(outputDirectory, entry.name));
    const artifact = await hashVerifiedArtifact({
      root,
      entrypoint: relativeEntry,
      label: `${label} ${entry.name}`,
    });
    totalBytes += artifact.bytes.length;
    if (totalBytes > MAX_GRAPH_TOTAL_BYTES) {
      throw new Error(`${label} JavaScript graph exceeds the total size bound`);
    }
    files.push({
      path: relativeEntry,
      sha256: artifact.sha256,
      bytes: artifact.bytes,
    });
  }
  files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return { files, totalBytes };
}

async function writePrivateFile(path, bytes) {
  const handle = await open(path, 'wx', 0o600);
  try {
    let offset = 0;
    while (offset < bytes.length) {
      const written = await handle.write(bytes, offset, bytes.length - offset, null);
      if (written.bytesWritten < 1) throw new Error('attested snapshot write made no progress');
      offset += written.bytesWritten;
    }
    await handle.sync();
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size !== bytes.length) {
      throw new Error('attested snapshot changed while writing');
    }
  } finally {
    await handle.close();
  }
}

async function createRuntimeSnapshot({ root, cliFiles, coreFiles }) {
  const packageRoot = resolve(root, 'packages/mcp-server');
  const directory = await mkdtemp(join(packageRoot, '.discord-mcp-attested-runtime-'));
  const files = [];
  const directories = new Set();
  try {
    await chmod(directory, 0o700);
    const copy = async (target, bytes) => {
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await writePrivateFile(target, bytes);
      files.push(target);
      let parent = dirname(target);
      while (parent !== directory) {
        directories.add(parent);
        parent = dirname(parent);
      }
    };
    for (const file of cliFiles) {
      await copy(join(directory, 'dist', basename(file.path)), file.bytes);
    }
    for (const file of coreFiles) {
      await copy(
        join(directory, 'node_modules', '@discord-mcp', 'core', 'dist', basename(file.path)),
        file.bytes,
      );
    }
    const packageJson = `${JSON.stringify({
      name: '@discord-mcp/core',
      type: 'module',
      main: './dist/index.js',
      exports: { '.': './dist/index.js' },
    })}\n`;
    await copy(
      join(directory, 'node_modules', '@discord-mcp', 'core', 'package.json'),
      Buffer.from(packageJson, 'utf8'),
    );
    const cleanup = async () => {
      for (const path of [...files].reverse()) await rm(path, { force: true });
      for (const path of [...directories].sort((left, right) => right.length - left.length)) {
        await rmdir(path);
      }
      const metadata = await lstat(directory).catch((error) => {
        if (error?.code === 'ENOENT') return null;
        throw error;
      });
      if (metadata?.isDirectory() && !metadata.isSymbolicLink()) await rmdir(directory);
    };
    return {
      cliPath: join(directory, 'dist', 'cli.js'),
      corePath: join(directory, 'node_modules', '@discord-mcp', 'core', 'dist', 'index.js'),
      cleanup,
    };
  } catch (error) {
    for (const path of [...files].reverse()) await rm(path, { force: true });
    for (const path of [...directories].sort((left, right) => right.length - left.length)) {
      await rmdir(path).catch(() => {});
    }
    await rmdir(directory).catch(() => {});
    throw error;
  }
}
