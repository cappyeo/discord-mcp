import { execFile as nodeExecFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assertBenchmarkSourceIntegrity } from './source-integrity.mjs';

const execFile = promisify(nodeExecFile);
const gitEnvironment = {
  ...process.env,
  GIT_AUTHOR_EMAIL: 'source-integrity@example.test',
  GIT_AUTHOR_NAME: 'Source Integrity Test',
  GIT_COMMITTER_EMAIL: 'source-integrity@example.test',
  GIT_COMMITTER_NAME: 'Source Integrity Test',
};

async function git(cwd, args) {
  return execFile('git', args, { cwd, encoding: 'utf8', env: gitEnvironment, windowsHide: true });
}

async function createRepository() {
  const cwd = await mkdtemp(join(tmpdir(), 'discord-mcp-source-integrity-'));
  await git(cwd, ['init', '--quiet']);
  await writeFile(join(cwd, 'tracked.txt'), 'initial\n');
  await git(cwd, ['add', 'tracked.txt']);
  await git(cwd, ['commit', '--quiet', '-m', 'initial']);
  const { stdout } = await git(cwd, ['rev-parse', 'HEAD']);
  return { cwd, commit: stdout.trim() };
}

let repository;

describe('assertBenchmarkSourceIntegrity', () => {
  beforeEach(async () => {
    repository = await createRepository();
  });

  afterEach(async () => {
    await rm(repository.cwd, { recursive: true, force: true });
  });

  it('accepts the exact committed source with no changes', async () => {
    await expect(
      assertBenchmarkSourceIntegrity({ cwd: repository.cwd, expectedCommit: repository.commit }),
    ).resolves.toEqual({ commit: repository.commit, allowed_untracked: [] });
  });

  it('rejects a wrong commit', async () => {
    const wrongCommit = `${repository.commit.slice(0, -1)}${repository.commit.endsWith('0') ? '1' : '0'}`;
    await expect(
      assertBenchmarkSourceIntegrity({ cwd: repository.cwd, expectedCommit: wrongCommit }),
    ).rejects.toThrow(/commit mismatch/);
  });

  it('rejects tracked unstaged changes', async () => {
    await writeFile(join(repository.cwd, 'tracked.txt'), 'changed\n');
    await expect(
      assertBenchmarkSourceIntegrity({ cwd: repository.cwd, expectedCommit: repository.commit }),
    ).rejects.toThrow(/not clean/);
  });

  it('rejects tracked staged changes', async () => {
    await writeFile(join(repository.cwd, 'tracked.txt'), 'staged\n');
    await git(repository.cwd, ['add', 'tracked.txt']);
    await expect(
      assertBenchmarkSourceIntegrity({ cwd: repository.cwd, expectedCommit: repository.commit }),
    ).rejects.toThrow(/not clean/);
  });

  it('allows untracked files below docs/', async () => {
    await writeFile(join(repository.cwd, 'docs-note.txt'), 'outside\n');
    await mkdir(join(repository.cwd, 'docs'), { recursive: true });
    await writeFile(join(repository.cwd, 'docs', 'evidence.txt'), 'evidence\n');
    await rm(join(repository.cwd, 'docs-note.txt'));

    await expect(
      assertBenchmarkSourceIntegrity({ cwd: repository.cwd, expectedCommit: repository.commit }),
    ).resolves.toEqual({
      commit: repository.commit,
      allowed_untracked: ['docs/evidence.txt'],
    });
  });

  it('rejects unrelated untracked files', async () => {
    await writeFile(join(repository.cwd, 'scratch.txt'), 'not allowed\n');
    await expect(
      assertBenchmarkSourceIntegrity({ cwd: repository.cwd, expectedCommit: repository.commit }),
    ).rejects.toThrow(/outside allowed prefixes/);
  });
});
