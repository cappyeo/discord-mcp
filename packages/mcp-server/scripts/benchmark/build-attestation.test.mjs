import { execFile as nodeExecFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

import { attestBuiltCli, buildBenchmarkCli } from './build-attestation.mjs';

const execFile = promisify(nodeExecFile);
const gitEnvironment = {
  ...process.env,
  GIT_AUTHOR_EMAIL: 'build-attestation@example.test',
  GIT_AUTHOR_NAME: 'Build Attestation Test',
  GIT_COMMITTER_EMAIL: 'build-attestation@example.test',
  GIT_COMMITTER_NAME: 'Build Attestation Test',
};

async function git(cwd, args) {
  return execFile('git', args, { cwd, encoding: 'utf8', env: gitEnvironment, windowsHide: true });
}

async function repository() {
  const cwd = await mkdtemp(join(tmpdir(), 'discord-mcp-build-attestation-'));
  await git(cwd, ['init', '--quiet']);
  await writeFile(join(cwd, '.gitignore'), 'packages/mcp-server/dist/\n');
  await writeFile(join(cwd, 'tracked.txt'), 'clean\n');
  await git(cwd, ['add', '.gitignore', 'tracked.txt']);
  await git(cwd, ['commit', '--quiet', '-m', 'initial']);
  const { stdout } = await git(cwd, ['rev-parse', 'HEAD']);
  return { cwd, commit: stdout.trim() };
}

const directories = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('built CLI attestation', () => {
  it('builds from the exact clean commit and hashes the resulting stdio entrypoint', async () => {
    const source = await repository();
    directories.push(source.cwd);
    const bytes = Buffer.from('#!/usr/bin/env node\nconsole.log("built");\n');
    const result = await attestBuiltCli({
      cwd: source.cwd,
      expectedCommit: source.commit,
      async build({ cwd }) {
        const output = join(cwd, 'packages', 'mcp-server', 'dist');
        await mkdir(output, { recursive: true });
        await writeFile(join(output, 'cli.js'), bytes);
      },
    });

    expect(result.attestation).toEqual({
      entrypoint: 'packages/mcp-server/dist/cli.js',
      sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      source_commit: source.commit,
    });
    expect(result.cliPath).toBe(
      await realpath(join(source.cwd, 'packages', 'mcp-server', 'dist', 'cli.js')),
    );
  });

  it('rejects a build that changes tracked source', async () => {
    const source = await repository();
    directories.push(source.cwd);

    await expect(
      attestBuiltCli({
        cwd: source.cwd,
        expectedCommit: source.commit,
        async build({ cwd }) {
          await writeFile(join(cwd, 'tracked.txt'), 'dirty\n');
        },
      }),
    ).rejects.toThrow(/not clean/);
  });

  it('rejects a stale ignored entrypoint when the current build produces nothing', async () => {
    const source = await repository();
    directories.push(source.cwd);
    const output = join(source.cwd, 'packages', 'mcp-server', 'dist');
    await mkdir(output, { recursive: true });
    await writeFile(join(output, 'cli.js'), 'console.log("stale");\n');

    await expect(
      attestBuiltCli({
        cwd: source.cwd,
        expectedCommit: source.commit,
        async build() {},
      }),
    ).rejects.toThrow();
  });

  it('invokes core before CLI with the platform package manager command', async () => {
    const calls = [];
    await buildBenchmarkCli({
      cwd: 'C:/workspace',
      async execFile(command, args, options) {
        calls.push({ command, args, options });
        return { stdout: '', stderr: '' };
      },
    });

    const pnpmArgs = [
      ['--filter', '@discord-mcp/core', 'build'],
      ['--filter', '@discord-mcp/cli', 'build'],
    ];
    const expectedCommand =
      process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : 'pnpm';
    const expectedArgs =
      process.platform === 'win32'
        ? pnpmArgs.map((args) => ['/d', '/s', '/c', 'pnpm.cmd', ...args])
        : pnpmArgs;

    expect(calls.map(({ command }) => command)).toEqual([expectedCommand, expectedCommand]);
    expect(calls.map(({ args }) => args)).toEqual(expectedArgs);
    expect(calls.every(({ options }) => options.cwd === 'C:/workspace')).toBe(true);
    expect(calls.every(({ options }) => options.shell === undefined)).toBe(true);
    expect(calls.every(({ options }) => options.windowsHide === true)).toBe(true);
  });
});
