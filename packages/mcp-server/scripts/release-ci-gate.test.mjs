import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { assertReleaseCi } from '../../../.github/scripts/assert-release-ci.mjs';
import { assertReleaseRef } from '../../../.github/scripts/assert-release-ref.mjs';

const sha = '0123456789abcdef0123456789abcdef01234567';
const response = (runs) => ({ ok: true, status: 200, json: async () => ({ workflow_runs: runs }) });

describe('release CI gate', () => {
  it('accepts a successful CI run for the exact release SHA', async () => {
    const run = {
      id: 42,
      path: '.github/workflows/ci.yml',
      head_sha: sha,
      head_branch: 'main',
      event: 'push',
      status: 'completed',
      conclusion: 'success',
    };
    await expect(
      assertReleaseCi({
        sha,
        repository: 'owner/repo',
        token: 'test-token',
        fetchImpl: async () => response([run]),
      }),
    ).resolves.toEqual(run);
  });

  it('rejects a successful run for a different SHA or workflow', async () => {
    const run = {
      id: 42,
      path: '.github/workflows/ci.yml',
      head_sha: `${sha.slice(0, -1)}8`,
      head_branch: 'main',
      event: 'push',
      status: 'completed',
      conclusion: 'success',
    };
    await expect(
      assertReleaseCi({
        sha,
        repository: 'owner/repo',
        token: 'test-token',
        fetchImpl: async () => response([run]),
      }),
    ).rejects.toThrow('no successful CI run');
  });

  it('rejects an incomplete or failed exact-SHA run', async () => {
    const runs = [
      {
        id: 1,
        path: '.github/workflows/ci.yml',
        head_sha: sha,
        head_branch: 'main',
        event: 'push',
        status: 'in_progress',
        conclusion: null,
      },
      {
        id: 2,
        path: '.github/workflows/ci.yml',
        head_sha: sha,
        head_branch: 'main',
        event: 'push',
        status: 'completed',
        conclusion: 'failure',
      },
    ];
    await expect(
      assertReleaseCi({
        sha,
        repository: 'owner/repo',
        token: 'test-token',
        fetchImpl: async () => response(runs),
      }),
    ).rejects.toThrow('1:in_progress/null, 2:completed/failure');
  });

  it('rejects successful CI that was not a push on the release branch', async () => {
    const run = {
      id: 42,
      path: '.github/workflows/ci.yml',
      head_sha: sha,
      head_branch: 'feature/untrusted-release',
      event: 'workflow_dispatch',
      status: 'completed',
      conclusion: 'success',
    };
    await expect(
      assertReleaseCi({
        sha,
        repository: 'owner/repo',
        token: 'test-token',
        fetchImpl: async () => response([run]),
      }),
    ).rejects.toThrow('no successful CI run');
  });

  it('wires npm publish and registry-only retries through trusted-main preflight', () => {
    const workflow = readFileSync(
      new URL('../../../.github/workflows/release.yml', import.meta.url),
      'utf8',
    );

    expect(workflow).toMatch(/ref: \$\{\{ github\.workflow_sha \}\}/);
    expect(workflow).toContain('run: node .release-trust/.github/scripts/assert-release-ci.mjs');
    expect(workflow).toContain(
      'run: node ../.release-trust/.github/scripts/assert-release-ref.mjs',
    );
    expect(workflow.match(/ref: \$\{\{ inputs\.tag \}\}/g)).toHaveLength(1);
    expect(workflow.match(/ref: \$\{\{ needs\.preflight\.outputs\.release_sha \}\}/g)).toHaveLength(
      2,
    );
    expect(workflow).toContain('needs: [preflight, publish]');
    expect(workflow).not.toContain('inputs.registry_only && github.sha');
  });
});

describe('release tag gate', () => {
  it('accepts only an existing semantic tag resolving to the checkout', () => {
    const gitImpl = () => sha;
    expect(assertReleaseRef({ tag: 'v0.25.1', gitImpl })).toEqual({ tag: 'v0.25.1', sha });
  });

  it('rejects a branch-like ref, a missing tag, and a mismatched checkout', () => {
    expect(() => assertReleaseRef({ tag: 'main', gitImpl: () => sha })).toThrow(
      'must be a semantic version tag',
    );
    expect(() =>
      assertReleaseRef({
        tag: 'v0.25.1',
        gitImpl: (args) => {
          if (args.includes('--verify')) throw new Error('missing');
          return sha;
        },
      }),
    ).toThrow('release tag v0.25.1 is missing');
    expect(() =>
      assertReleaseRef({
        tag: 'v0.25.1',
        gitImpl: (args) => (args.includes('--verify') ? `${sha.slice(0, -1)}8` : sha),
      }),
    ).toThrow('but checkout is');
  });
});
