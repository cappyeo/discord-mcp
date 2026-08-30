import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { assertReleaseCi } from '../../../.github/scripts/assert-release-ci.mjs';

const sha = '0123456789abcdef0123456789abcdef01234567';
const response = (runs) => ({ ok: true, status: 200, json: async () => ({ workflow_runs: runs }) });

describe('release CI gate', () => {
  it('accepts a successful CI run for the exact release SHA', async () => {
    const run = {
      id: 42,
      path: '.github/workflows/ci.yml',
      head_sha: sha,
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
        status: 'in_progress',
        conclusion: null,
      },
      {
        id: 2,
        path: '.github/workflows/ci.yml',
        head_sha: sha,
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

  it('wires both npm publish and registry-only retries to the exact tag CI gate', () => {
    const workflow = readFileSync(
      new URL('../../../.github/workflows/release.yml', import.meta.url),
      'utf8',
    );

    expect(workflow.match(/run: node \.github\/scripts\/assert-release-ci\.mjs/g)).toHaveLength(2);
    expect(workflow.match(/ref: \$\{\{ inputs\.tag \}\}/g)).toHaveLength(2);
    expect(workflow).not.toContain('inputs.registry_only && github.sha');
  });
});
