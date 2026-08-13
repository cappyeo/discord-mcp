import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSmallModelIntegrity } from './small-model-attestation.mjs';
import { SMALL_MODEL_LIVE_REQUEST } from './small-model-live-eval.mjs';
import { createSmallModelLiveArtifact } from './small-model-live-run.mjs';
import {
  parseSmallModelLiveVerifierArgs,
  verifySmallModelLiveRun,
} from './verify-small-model-live.mjs';

const COMMIT = 'a'.repeat(40);
const GUILD = '1537332825978568744';
const BOT = '1533719084636700773';
const PLAN = `sha256:${'1'.repeat(64)}`;
const BLUEPRINT = `sha256:${'2'.repeat(64)}`;
const EVIDENCE = `sha256:${'3'.repeat(64)}`;
const FINGERPRINT = `sha256:${'4'.repeat(64)}`;
const TOKEN = 'fixture-integrity-key';
const directories = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

function summary() {
  return {
    schema_version: 'discord-mcp.small-model-live-run.v1',
    status: 'passed',
    model: 'gpt-5.6-luna',
    request: SMALL_MODEL_LIVE_REQUEST,
    target: { guild_id: GUILD, bot_id: BOT },
    plan: {
      plan_id: PLAN,
      blueprint_id: BLUEPRINT,
      operation_count: 1,
      source: {
        permission_policy: 'discard_source_and_regenerate',
        primary: {
          code: 'fixture',
          use_url: 'https://discord.new/fixture',
          quality: {
            verified: true,
            code_match: true,
            permission_handling: 'discarded_and_regenerated',
          },
          provenance: {
            evidence_digest: `sha256:${'5'.repeat(64)}`,
            fetched_at: '2026-08-13T00:00:00.000Z',
            source_guild: { id: '1537332825978568751' },
          },
        },
        inspirations: [],
      },
    },
    apply: { status: 'complete', completed_total: 1 },
    evidence: {
      status: 'verified',
      evidence_id: EVIDENCE,
      digest_verified: true,
      evidence_body: {
        plan_id: PLAN,
        blueprint_id: BLUEPRINT,
        target: { guild_id: GUILD, bot_id: BOT },
        initial_operation_count: 1,
        observed: { completed_operation_ids: ['role:create:member'] },
      },
    },
    baseline: { fingerprint_before: FINGERPRINT, fingerprint_after: FINGERPRINT },
    oracle: { match: true, failure_count: 0 },
    evaluator: {
      status: 'complete',
      session_digest: `sha256:${'6'.repeat(64)}`,
      initial_trace: [
        {
          tool: 'build_discord_server',
          status: 'completed',
          result_summary: { plan_id: PLAN, blueprint_id: BLUEPRINT },
        },
      ],
      trace: [
        {
          tool: 'guild_blueprint_apply',
          status: 'completed',
          confirmed: true,
          result_summary: { status: 'complete', plan_id: PLAN, blueprint_id: BLUEPRINT },
        },
        {
          tool: 'guild_blueprint_evidence',
          status: 'completed',
          result_summary: {
            status: 'verified',
            plan_id: PLAN,
            blueprint_id: BLUEPRINT,
            evidence_id: EVIDENCE,
          },
        },
      ],
    },
  };
}

function artifact() {
  const value = createSmallModelLiveArtifact({
    summary: summary(),
    expectedCommit: COMMIT,
    restored: true,
    builtCli: {
      attestation: {
        entrypoint: 'packages/mcp-server/dist/cli.js',
        sha256: `sha256:${'7'.repeat(64)}`,
        source_commit: COMMIT,
        core_entrypoint: 'packages/mcp-core/dist/index.js',
        core_sha256: `sha256:${'8'.repeat(64)}`,
        core_source_commit: COMMIT,
        files: [],
        core_files: [],
      },
    },
  });
  value.integrity = createSmallModelIntegrity({ artifact: value, integrityKey: TOKEN });
  return value;
}

async function writeArtifact(value) {
  const root = await mkdtemp(join(tmpdir(), 'discord-mcp-small-model-live-verifier-'));
  directories.push(root);
  const results = join(root, 'runs', 'fixture-run', 'results');
  await mkdir(results, { recursive: true });
  await writeFile(join(results, 'small-model-live.json'), JSON.stringify(value), {
    encoding: 'utf8',
    mode: 0o600,
  });
  return root;
}

describe('small-model live independent verifier', () => {
  it('parses a strict artifact location contract', () => {
    expect(
      parseSmallModelLiveVerifierArgs([
        '--expected-commit',
        COMMIT,
        '--artifact-root',
        resolve(tmpdir(), 'artifacts'),
        '--run-id',
        'fixture-run',
      ]),
    ).toEqual({
      expectedCommit: COMMIT,
      artifactRoot: resolve(tmpdir(), 'artifacts'),
      runId: 'fixture-run',
    });
    expect(() =>
      parseSmallModelLiveVerifierArgs([
        '--expected-commit',
        'bad',
        '--artifact-root',
        resolve(tmpdir(), 'artifacts'),
        '--run-id',
        'fixture-run',
      ]),
    ).toThrow('full lowercase Git SHA');
  });

  it('verifies HMAC, exact build seam, and attested Activity Evidence callback', async () => {
    const root = await writeArtifact(artifact());
    const sourceIntegrity = vi.fn(async () => ({}));
    const builtArtifacts = vi.fn(async () => ({ coreArtifact: { sha256: 'verified-core' } }));
    const validate = vi.fn();
    const loadValidator = vi.fn(async () => validate);
    const result = await verifySmallModelLiveRun({
      artifactRoot: root,
      runId: 'fixture-run',
      expectedCommit: COMMIT,
      integrityKey: TOKEN,
      repoRoot: process.cwd(),
      sourceIntegrity,
      builtArtifacts,
      loadValidator,
    });
    expect(result).toEqual(
      expect.objectContaining({ verified: true, expected_commit: COMMIT, evidence_id: EVIDENCE }),
    );
    expect(sourceIntegrity).toHaveBeenCalledWith({ cwd: process.cwd(), expectedCommit: COMMIT });
    expect(builtArtifacts).toHaveBeenCalled();
    expect(loadValidator).toHaveBeenCalled();
    expect(validate).toHaveBeenCalledTimes(1);
  });

  it('accepts a bounded partial apply followed by the terminal complete apply', async () => {
    const value = artifact();
    value.summary.evaluator.trace.unshift({
      tool: 'guild_blueprint_apply',
      status: 'completed',
      confirmed: true,
      result_summary: { status: 'partial', plan_id: PLAN, blueprint_id: BLUEPRINT },
    });
    value.integrity = createSmallModelIntegrity({ artifact: value, integrityKey: TOKEN });
    const root = await writeArtifact(value);
    await expect(
      verifySmallModelLiveRun({
        artifactRoot: root,
        runId: 'fixture-run',
        expectedCommit: COMMIT,
        integrityKey: TOKEN,
        repoRoot: process.cwd(),
        sourceIntegrity: async () => ({}),
        builtArtifacts: async () => ({ coreArtifact: {} }),
        loadValidator: async () => () => {},
      }),
    ).resolves.toEqual(expect.objectContaining({ verified: true }));
  });

  it('rejects completed-operation evidence that disagrees with the terminal apply', async () => {
    const value = artifact();
    value.summary.evidence.evidence_body.observed.completed_operation_ids = [];
    value.integrity = createSmallModelIntegrity({ artifact: value, integrityKey: TOKEN });
    const root = await writeArtifact(value);
    await expect(
      verifySmallModelLiveRun({
        artifactRoot: root,
        runId: 'fixture-run',
        expectedCommit: COMMIT,
        integrityKey: TOKEN,
        repoRoot: process.cwd(),
        sourceIntegrity: async () => ({}),
        builtArtifacts: async () => ({ coreArtifact: {} }),
        loadValidator: async () => () => {},
      }),
    ).rejects.toThrow('small-model live lifecycle evidence is invalid');
  });

  it('rejects a changed artifact before accepting lifecycle claims', async () => {
    const value = artifact();
    value.summary.oracle.match = false;
    const root = await writeArtifact(value);
    await expect(
      verifySmallModelLiveRun({
        artifactRoot: root,
        runId: 'fixture-run',
        expectedCommit: COMMIT,
        integrityKey: TOKEN,
        repoRoot: process.cwd(),
        sourceIntegrity: async () => ({}),
        builtArtifacts: async () => ({ coreArtifact: {} }),
        loadValidator: async () => () => {},
      }),
    ).rejects.toThrow('HMAC check failed');
  });
});
