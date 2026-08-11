import { execFile as nodeExecFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath, rm, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { promisify } from 'node:util';

import { assertBenchmarkSourceIntegrity } from './source-integrity.mjs';

const execFile = promisify(nodeExecFile);
const ENTRYPOINT = 'packages/mcp-server/dist/cli.js';
const OUTPUT_DIRECTORY = 'packages/mcp-server/dist';
const MAX_CLI_BYTES = 50 * 1024 * 1024;

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

async function clearOutputDirectory(cwd) {
  const root = await realpath(cwd);
  const output = resolve(cwd, OUTPUT_DIRECTORY);
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
  await build({ cwd });
  const source = await sourceIntegrity({ cwd, expectedCommit });

  const root = await realpath(cwd);
  const candidate = resolve(cwd, ENTRYPOINT);
  const candidateMetadata = await lstat(candidate);
  if (candidateMetadata.isSymbolicLink())
    throw new Error('built CLI entrypoint must not be a symlink');
  const cliPath = await realpath(candidate);
  if (!isWithin(root, cliPath)) throw new Error('built CLI resolves outside the source repository');
  const metadata = await stat(cliPath);
  if (!metadata.isFile() || metadata.size < 1 || metadata.size > MAX_CLI_BYTES) {
    throw new Error('built CLI artifact is missing or outside the size bound');
  }
  const bytes = await readFile(cliPath);
  const sha256 = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  return {
    attestation: {
      entrypoint: ENTRYPOINT,
      sha256,
      source_commit: source.commit,
    },
    cliPath,
    allowedUntracked: source.allowed_untracked,
  };
}
