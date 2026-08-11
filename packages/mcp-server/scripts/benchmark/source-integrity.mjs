import { execFile as nodeExecFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(nodeExecFile);
const FULL_LOWERCASE_SHA = /^[a-f0-9]{40}$/;
const WINDOWS_ABSOLUTE_PATH = /^[a-z]:\//i;

function asText(value) {
  return Buffer.isBuffer(value) ? value.toString('utf8') : String(value ?? '');
}

function normalizeSlash(value) {
  return value.replaceAll('\\', '/');
}

function rejectUnsafePath(path, label) {
  if (path.length === 0) throw new Error(`${label}: empty path`);
  if (
    [...path].some((character) => {
      const code = character.codePointAt(0);
      return code <= 0x1f || code === 0x7f;
    })
  ) {
    throw new Error(`${label}: control characters are not allowed`);
  }
  if (path.startsWith('/') || path.startsWith('//') || WINDOWS_ABSOLUTE_PATH.test(path)) {
    throw new Error(`${label}: absolute paths are not allowed`);
  }
  if (path.split('/').some((segment) => segment === '..')) {
    throw new Error(`${label}: path traversal is not allowed`);
  }
  if (path.split('/').some((segment) => segment === '')) {
    throw new Error(`${label}: empty path segments are not allowed`);
  }
}

function normalizeAllowedPrefixes(prefixes) {
  if (!Array.isArray(prefixes) || prefixes.length === 0) {
    throw new TypeError('allowedUntrackedPrefixes must be a non-empty array');
  }

  return [
    ...new Set(
      prefixes.map((prefix) => {
        if (typeof prefix !== 'string') {
          throw new TypeError('allowedUntrackedPrefixes must contain strings');
        }
        const normalized = normalizeSlash(prefix);
        if (!normalized.endsWith('/')) {
          throw new TypeError('allowed untracked prefixes must end with /');
        }
        rejectUnsafePath(normalized.slice(0, -1), 'allowed untracked prefix');
        return normalized;
      }),
    ),
  ];
}

function parseStatus(output, allowedPrefixes) {
  if (output.length === 0) return [];
  if (!output.endsWith('\0')) {
    throw new Error('git status returned an unterminated porcelain record');
  }

  const records = output.split('\0');
  records.pop();
  const allowedUntracked = [];

  for (const record of records) {
    if (record.length < 4 || record[2] !== ' ') {
      throw new Error('git status returned a malformed porcelain record');
    }

    const status = record.slice(0, 2);
    const rawPath = record.slice(3);
    if (status !== '??') {
      throw new Error(`benchmark source is not clean: status ${JSON.stringify(status)}`);
    }

    const path = normalizeSlash(rawPath);
    const validationPath = path.endsWith('/') ? path.slice(0, -1) : path;
    rejectUnsafePath(validationPath, 'untracked path');
    if (
      !allowedPrefixes.some(
        (prefix) => validationPath === prefix.slice(0, -1) || validationPath.startsWith(prefix),
      )
    ) {
      throw new Error(`untracked path is outside allowed prefixes: ${path}`);
    }
    allowedUntracked.push(path);
  }

  return [...new Set(allowedUntracked)].sort();
}

async function runGit(gitExecFile, cwd, args) {
  const result = await gitExecFile('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
  });
  return asText(result?.stdout);
}

export async function assertBenchmarkSourceIntegrity({
  cwd,
  expectedCommit,
  execFile: gitExecFile = execFile,
  allowedUntrackedPrefixes = ['docs/'],
}) {
  if (typeof expectedCommit !== 'string' || !FULL_LOWERCASE_SHA.test(expectedCommit)) {
    throw new TypeError('expectedCommit must be a full lowercase Git commit SHA');
  }
  if (typeof gitExecFile !== 'function') throw new TypeError('execFile must be a function');

  const allowedPrefixes = normalizeAllowedPrefixes(allowedUntrackedPrefixes);
  const commit = asText(await runGit(gitExecFile, cwd, ['rev-parse', 'HEAD'])).trim();
  if (commit !== expectedCommit || !FULL_LOWERCASE_SHA.test(commit)) {
    throw new Error(`benchmark source commit mismatch: expected ${expectedCommit}, got ${commit}`);
  }

  const status = await runGit(gitExecFile, cwd, [
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=all',
  ]);
  return { commit, allowed_untracked: parseStatus(status, allowedPrefixes) };
}
