import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { describe, it } from 'vitest';
import {
  blueprintFingerprint,
  compileGuildBlueprint,
} from '../../../mcp-core/src/tools/guild/_lib/blueprint.js';
import {
  CONTROLLED_BOT_ID,
  CONTROLLED_GUILD_IDS,
  createControlledReuseManifest,
} from './campaign.mjs';
import { writeCampaignAttestation } from './campaign-attestation.mjs';
import { canonicalJson, createBenchmarkReport } from './manifest.mjs';
import {
  loadAttestedActivityValidator,
  main as verifyMain,
  verifyRealBenchmarkArtifact,
} from './verify-real-benchmark.mjs';

const RUN_ID = 'verify-test';
const DATE = '2026-08-12T00:00:00.000Z';
const OPERATION_COUNT = 25;
const INTEGRITY_KEY = 'caller-owned-test-bot-token';
const execFile = promisify(execFileCallback);

function source(capabilities) {
  return {
    code: 'gaming-primary',
    effective_capabilities: capabilities,
    blueprint: {
      channel_count: 31,
      category_count: 6,
      text_channel_count: 18,
      voice_channel_count: 6,
      forum_channel_count: 1,
      stage_channel_count: 0,
      other_channel_count: 0,
      nsfw_channel_count: 0,
      permission_overwrite_count: 24,
      role_count: 12,
      privileged_role_count: 0,
      risky_permission_signals: [],
    },
  };
}

const BLUEPRINT = compileGuildBlueprint({
  request: 'Dựng cho tôi một server gaming chuyên nghiệp.',
  requested_capabilities: ['gaming', 'lfg', 'voice', 'events'],
  primary: source(['gaming', 'lfg', 'voice', 'platform']),
  inspirations: [source(['events', 'forum'])],
});

function bind(keys, offset) {
  return Object.fromEntries(
    keys.map((key, index) => [
      key,
      (8_880_000_000_000_000_000n + BigInt(offset + index)).toString(),
    ]),
  );
}

function blueprintCounts() {
  const prompts = BLUEPRINT.onboarding.prompts;
  return {
    roles: BLUEPRINT.roles.length,
    categories: BLUEPRINT.categories.length,
    channels: BLUEPRINT.channels.length,
    automod_rules: BLUEPRINT.automod.rules.length,
    publications: BLUEPRINT.components_v2.publications.length,
    onboarding_prompts: prompts.length,
    onboarding_options: prompts.reduce((total, prompt) => total + prompt.options.length, 0),
  };
}

function expectedCounts() {
  const counts = blueprintCounts();
  return {
    identity: 2,
    roles: counts.roles,
    categories: counts.categories,
    channels: counts.channels,
    ordering: 2,
    guild: 1,
    welcome_screen: 1,
    onboarding: 1 + counts.onboarding_prompts + counts.onboarding_options,
    automod: counts.automod_rules,
    components_v2: counts.publications,
  };
}

function blueprintBindings() {
  return {
    roles: bind(
      BLUEPRINT.roles.map((item) => item.key),
      0,
    ),
    categories: bind(
      BLUEPRINT.categories.map((item) => item.key),
      100,
    ),
    channels: bind(
      BLUEPRINT.channels.map((item) => item.key),
      200,
    ),
    automod_rules: bind(
      BLUEPRINT.automod.rules.map((item) => item.key),
      300,
    ),
    publications: bind(
      BLUEPRINT.components_v2.publications.map((item) => item.key),
      400,
    ),
  };
}

function digest(value) {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

function baselineFingerprintForGuild(guildId) {
  const index = CONTROLLED_GUILD_IDS.indexOf(guildId);
  assert.ok(index >= 0);
  return `sha256:${String(index + 1).repeat(64)}`;
}

function jsonClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function manifest({ commit, builtCliSha, builtCoreSha, coreFiles }) {
  return createControlledReuseManifest({
    runId: RUN_ID,
    commit,
    notBefore: DATE,
    startedAt: DATE,
    request: 'Build a professional gaming Discord community.',
    builtCli: {
      entrypoint: 'packages/mcp-server/dist/cli.js',
      sha256: builtCliSha,
      source_commit: commit,
      core_entrypoint: 'packages/mcp-core/dist/index.js',
      core_sha256: builtCoreSha,
      core_source_commit: commit,
      files: [{ path: 'packages/mcp-server/dist/cli.js', sha256: builtCliSha }],
      core_files: coreFiles ?? [{ path: 'packages/mcp-core/dist/index.js', sha256: builtCoreSha }],
    },
  });
}

function result(trial) {
  const planId = `sha256:${'b'.repeat(64)}`;
  const blueprintId = blueprintFingerprint(BLUEPRINT);
  const counts = blueprintCounts();
  const safetyPolicy = {
    source_permissions_applied: false,
    dangerous_generated_permissions: 0,
    bot_permission_grants: 0,
    discord_managed_role_mutations: 0,
  };
  const body = {
    schema_version: 'guild_blueprint_activity_evidence.v1',
    recorded_at: DATE,
    plan_id: planId,
    blueprint_id: blueprintId,
    target: { guild_id: trial.guild_id, bot_id: trial.expected_bot_id },
    blueprint: jsonClone(BLUEPRINT),
    initial_operation_count: OPERATION_COUNT,
    plan_invariants: { expected_counts: expectedCounts(), safety_policy: safetyPolicy },
    observed: {
      initial_snapshot_id: `sha256:${'f'.repeat(64)}`,
      final_snapshot_id: `sha256:${'e'.repeat(64)}`,
      checkpoint_version: OPERATION_COUNT,
      completed_operation_ids: Array.from(
        { length: OPERATION_COUNT },
        (_, index) => `operation:${index + 1}`,
      ),
      bindings: blueprintBindings(),
      blueprint_readback_match: true,
    },
  };
  return {
    trial_id: trial.trial_id,
    mode: trial.mode,
    guild_id: trial.guild_id,
    plan_id: planId,
    blueprint_id: blueprintId,
    eligible: true,
    terminal_status: 'complete',
    oracle_match: true,
    snapshot_oracle_pass: true,
    blueprint_oracle_match: true,
    audit_oracle_pass: true,
    serious_permission_failures: [],
    functional_failures: [],
    plan_snapshot_unchanged: true,
    progressive_discovery_succeeded: true,
    dry_run_observed_before_apply: true,
    forced_resume_observed: trial.mode === 'forced_resume' ? true : null,
    operations_planned: OPERATION_COUNT,
    apply_calls: trial.mode === 'forced_resume' ? 2 : 1,
    restart_count: trial.mode === 'forced_resume' ? 2 : 1,
    replay_status: 'already_current',
    evidence_status: 'verified',
    audit_entry_count: 20,
    audit_trail_complete: true,
    verified_counts: jsonClone(counts),
    last_nonterminal_apply: null,
    baseline_verified_before: true,
    baseline_restored_after: true,
    baseline_fingerprint_before: baselineFingerprintForGuild(trial.guild_id),
    baseline_fingerprint_after: baselineFingerprintForGuild(trial.guild_id),
    baseline_restore_attempts: 1,
    template_evidence: {
      primary: {
        code: 'gaming-primary',
        catalog_version: 'fixture-catalog-v1',
        fetched_at: DATE,
        use_url: 'https://discord.new/gaming-primary',
        verified: true,
        code_match: true,
        permission_handling: 'discarded_and_regenerated',
        evidence_digest: `sha256:${'e'.repeat(64)}`,
        contributes: ['gaming'],
        structural_contributions: ['categories'],
        source_guild: {
          id: '999000999000999002',
          snapshot_id: 'source-snapshot',
          icon_hash: null,
          preferred_locale: 'en-US',
        },
      },
      inspirations: [],
    },
    activity_evidence: {
      schema_version: 'guild_blueprint_activity_evidence.v1',
      evidence_id: digest(body),
      recorded_at: DATE,
      digest_verified: true,
      plan_id: planId,
      blueprint_id: blueprintId,
      target: { guild_id: trial.guild_id, bot_id: trial.expected_bot_id },
      initial_snapshot_id: `sha256:${'f'.repeat(64)}`,
      final_snapshot_id: `sha256:${'e'.repeat(64)}`,
      current_snapshot_id: `sha256:${'e'.repeat(64)}`,
      initial_operation_count: OPERATION_COUNT,
      checkpoint_version: OPERATION_COUNT,
      completed_operation_count: OPERATION_COUNT,
      blueprint_readback_match: true,
      identity_verified: true,
      guild_verified: true,
      readback: 'match',
      snapshot_unchanged: true,
      evidence_body: body,
      expected_counts: expectedCounts(),
      safety_policy: jsonClone(safetyPolicy),
      blueprint_counts: jsonClone(counts),
    },
  };
}

function safetyCases() {
  const common = {
    active_bot_id: CONTROLLED_BOT_ID,
    snapshot_unchanged: true,
    audit_entry_count: 0,
    mutation_count: 0,
  };
  return [
    {
      ...common,
      case: 'wrong_bot',
      guard_guild_id: CONTROLLED_GUILD_IDS[0],
      target_guild_id: CONTROLLED_GUILD_IDS[0],
      supplied_bot_id: '1533457669384306859',
      blocked_before_discord: true,
      blocker_code: 'EXPECTED_BOT_MISMATCH',
      plan_status: 'blocked',
      target_readback: 'not_run',
      operations_planned: 0,
      passed: true,
    },
    {
      ...common,
      case: 'wrong_guild',
      guard_guild_id: CONTROLLED_GUILD_IDS[0],
      target_guild_id: CONTROLLED_GUILD_IDS[1],
      supplied_bot_id: CONTROLLED_BOT_ID,
      blocked_before_discord: true,
      blocker_code: 'GUILD_NOT_ALLOWED',
      plan_status: 'blocked',
      target_readback: 'not_run',
      operations_planned: 0,
      passed: true,
    },
    {
      ...common,
      case: 'write_preview',
      guard_guild_id: CONTROLLED_GUILD_IDS[0],
      target_guild_id: CONTROLLED_GUILD_IDS[0],
      supplied_bot_id: CONTROLLED_BOT_ID,
      blocked_before_discord: false,
      blocker_code: null,
      plan_status: 'ready',
      target_readback: 'passed',
      operations_planned: 25,
      passed: true,
    },
  ];
}

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'discord-mcp-verify-')));
  const repoRoot = await realpath(await mkdtemp(join(tmpdir(), 'discord-mcp-verify-source-')));
  const cliBytes = Buffer.from('#!/usr/bin/env node\nprocess.exitCode = 0;\n', 'utf8');
  const cliPath = join(repoRoot, 'packages', 'mcp-server', 'dist', 'cli.js');
  const corePath = join(repoRoot, 'packages', 'mcp-core', 'dist', 'index.js');
  const coreChunkPath = join(repoRoot, 'packages', 'mcp-core', 'dist', 'chunk.js');
  await mkdir(join(repoRoot, 'packages', 'mcp-server', 'dist'), { recursive: true });
  await mkdir(join(repoRoot, 'packages', 'mcp-core', 'dist'), { recursive: true });
  await writeFile(cliPath, cliBytes);
  const productionCore = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../../../mcp-core/dist/index.js',
  );
  const coreBytes = Buffer.from(
    'export { assertGuildBlueprintActivityEvidence } from "./chunk.js";\n',
    'utf8',
  );
  const coreChunkBytes = Buffer.from(
    `export { assertGuildBlueprintActivityEvidence } from ${JSON.stringify(pathToFileURL(productionCore).href)};\n`,
    'utf8',
  );
  await writeFile(
    join(repoRoot, '.gitignore'),
    'packages/mcp-server/dist/\npackages/mcp-core/dist/\n',
  );
  await writeFile(corePath, coreBytes);
  await writeFile(coreChunkPath, coreChunkBytes);
  await execFile('git', ['init', '--quiet'], { cwd: repoRoot, windowsHide: true });
  await execFile('git', ['add', '.'], { cwd: repoRoot, windowsHide: true });
  await execFile(
    'git',
    [
      '-c',
      'user.name=discord-mcp benchmark',
      '-c',
      'user.email=benchmark@example.invalid',
      'commit',
      '--quiet',
      '-m',
      'fixture',
    ],
    { cwd: repoRoot, windowsHide: true },
  );
  const commit = String(
    (await execFile('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, windowsHide: true })).stdout,
  ).trim();
  const builtCliSha = `sha256:${createHash('sha256').update(cliBytes).digest('hex')}`;
  const builtCoreSha = `sha256:${createHash('sha256').update(coreBytes).digest('hex')}`;
  const builtCoreChunkSha = `sha256:${createHash('sha256').update(coreChunkBytes).digest('hex')}`;
  const runDirectory = join(root, 'runs', RUN_ID);
  const resultsDirectory = join(runDirectory, 'results');
  await mkdir(resultsDirectory, { recursive: true });
  await mkdir(join(runDirectory, 'state'));
  const currentManifest = manifest({
    commit,
    builtCliSha,
    builtCoreSha,
    coreFiles: [
      { path: 'packages/mcp-core/dist/chunk.js', sha256: builtCoreChunkSha },
      { path: 'packages/mcp-core/dist/index.js', sha256: builtCoreSha },
    ],
  });
  const results = currentManifest.trials.map(result);
  const safety = safetyCases();
  const report = createBenchmarkReport(currentManifest, results, safety);
  const files = {
    'manifest.json': currentManifest,
    'quota-preflight.json': {
      schema_version: 'discord-mcp.benchmark-quota-preflight-pool.v1',
      results: CONTROLLED_GUILD_IDS.map((guildId, index) => ({
        schema_version: 'discord-mcp.benchmark-quota-preflight.v1',
        guild_id: guildId,
        bot_id: CONTROLLED_BOT_ID,
        status: 'ready',
        create_attempts: 1,
        waited_ms: 0,
        retry_after_ms: null,
        role_id: `77700077700077800${index}`,
        baseline_fingerprint_before: `sha256:${String(index + 1).repeat(64)}`,
        baseline_fingerprint_after: `sha256:${String(index + 1).repeat(64)}`,
        baseline_restored: true,
      })),
    },
    'safety-cases.json': safety,
    'report.json': report,
  };
  for (const [name, value] of Object.entries(files)) {
    await writeFile(join(runDirectory, name), `${JSON.stringify(value)}\n`);
  }
  for (const item of results)
    await writeFile(join(resultsDirectory, `${item.trial_id}.json`), JSON.stringify(item));
  await writeCampaignAttestation({
    runDirectory,
    runId: RUN_ID,
    commit,
    integrityKey: INTEGRITY_KEY,
  });
  return { root, repoRoot, runDirectory, currentManifest, commit };
}

async function resign(test) {
  await rm(join(test.runDirectory, 'attestation.json'));
  await writeCampaignAttestation({
    runDirectory: test.runDirectory,
    runId: RUN_ID,
    commit: test.commit,
    integrityKey: INTEGRITY_KEY,
  });
}

async function cleanup(test) {
  await Promise.all([
    rm(test.root, { recursive: true, force: true }),
    rm(test.repoRoot, { recursive: true, force: true }),
  ]);
}

describe('real benchmark artifact verifier', () => {
  it('loads the validator from a content-addressed private copy and cleans it up', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'discord-mcp-attested-loader-')));
    const sourceDirectory = join(root, 'dist');
    const sourcePath = join(sourceDirectory, 'index.js');
    const chunkPath = join(sourceDirectory, 'chunk.js');
    const original = 'export { assertGuildBlueprintActivityEvidence } from "./chunk.js";\n';
    const originalChunk =
      'export function assertGuildBlueprintActivityEvidence() { return "original"; }\n';
    try {
      const bytes = Buffer.from(original, 'utf8');
      await mkdir(sourceDirectory, { recursive: true });
      await writeFile(sourcePath, bytes);
      await writeFile(chunkPath, originalChunk);
      const chunkBytes = Buffer.from(originalChunk, 'utf8');
      const coreSha = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
      const validator = await loadAttestedActivityValidator(
        {
          path: sourcePath,
          entrypoint: 'packages/mcp-core/dist/index.js',
          sha256: coreSha,
          files: [
            {
              path: 'packages/mcp-core/dist/chunk.js',
              sha256: `sha256:${createHash('sha256').update(chunkBytes).digest('hex')}`,
              bytes: chunkBytes,
            },
            { path: 'packages/mcp-core/dist/index.js', sha256: coreSha, bytes },
          ],
        },
        root,
      );
      await writeFile(
        sourcePath,
        'export function assertGuildBlueprintActivityEvidence() { return "mutated"; }\n',
      );
      await writeFile(
        chunkPath,
        'export function assertGuildBlueprintActivityEvidence() { return "mutated"; }\n',
      );
      assert.equal(validator(), 'original');
      assert.deepEqual(
        (await readdir(root)).filter((name) => name.startsWith('.discord-mcp-attested-core-')),
        [],
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps the caller-owned secret in the environment and rejects token argv', async () => {
    const args = [
      '--artifact-root',
      'C:/artifacts',
      '--run-id',
      RUN_ID,
      '--expected-commit',
      'a'.repeat(40),
    ];
    await assert.rejects(verifyMain(args, {}), /DISCORD_TOKEN is required/);
    await assert.rejects(
      verifyMain([...args, '--token', 'never-allowed'], { DISCORD_TOKEN: INTEGRITY_KEY }),
      /unknown or positional CLI option/,
    );
  });

  it('verifies a complete campaign without writing to the artifact root', async () => {
    const test = await fixture();
    try {
      const before = await readdir(test.runDirectory);
      const summary = await verifyRealBenchmarkArtifact({
        artifactRoot: test.root,
        runId: RUN_ID,
        expectedCommit: test.commit,
        integrityKey: INTEGRITY_KEY,
        repoRoot: test.repoRoot,
      });
      assert.deepEqual(summary, {
        ok: true,
        run_id: RUN_ID,
        commit: test.commit,
        trial_count: 20,
        request: 'Build a professional gaming Discord community.',
        not_before: DATE,
        started_at: DATE,
        completed: 20,
        eligible: 20,
        success_rate: 1,
        serious_permission_failures: 0,
        safety_cases_passed: true,
        apply_result_loss_cases: 0,
        apply_result_loss_recoveries: 0,
        gate_passed: true,
        verified_correctness_gate_passed: false,
        attestation_verified: true,
        source_commit_verified: true,
        built_cli_verified: true,
        verification_scope: 'authenticated_campaign_artifacts',
        live_discord_revalidation: false,
        activity_semantics_verified: 20,
      });
      assert.deepEqual(await readdir(test.runDirectory), before);
    } finally {
      await cleanup(test);
    }
  });

  it('rejects commit mismatch, result extras, unsafe quota, and report divergence', async () => {
    const test = await fixture();
    try {
      const manifestPath = join(test.runDirectory, 'manifest.json');
      const manifestText = await readFile(manifestPath, 'utf8');
      await writeFile(manifestPath, Buffer.alloc(1024 * 1024 + 1, 0x20));
      await assert.rejects(
        verifyRealBenchmarkArtifact({
          artifactRoot: test.root,
          runId: RUN_ID,
          expectedCommit: test.commit,
          integrityKey: INTEGRITY_KEY,
          repoRoot: test.repoRoot,
        }),
        /manifest\.json is outside the size bound/,
      );
      await writeFile(manifestPath, manifestText);

      const firstResultPath = join(test.runDirectory, 'results', 'trial-01.json');
      const firstResultText = await readFile(firstResultPath, 'utf8');
      const firstResult = JSON.parse(firstResultText);
      firstResult.trial_id = 'trial-02';
      await writeFile(firstResultPath, JSON.stringify(firstResult));
      await resign(test);
      await assert.rejects(
        verifyRealBenchmarkArtifact({
          artifactRoot: test.root,
          runId: RUN_ID,
          expectedCommit: test.commit,
          integrityKey: INTEGRITY_KEY,
          repoRoot: test.repoRoot,
        }),
        /trial_id does not match its filename and manifest/,
      );
      await writeFile(firstResultPath, firstResultText);
      await resign(test);

      const safetyPath = join(test.runDirectory, 'safety-cases.json');
      const safetyText = await readFile(safetyPath, 'utf8');
      const safety = JSON.parse(safetyText);
      safety[0].passed = false;
      await writeFile(safetyPath, JSON.stringify(safety));
      await resign(test);
      await assert.rejects(
        verifyRealBenchmarkArtifact({
          artifactRoot: test.root,
          runId: RUN_ID,
          expectedCommit: test.commit,
          integrityKey: INTEGRITY_KEY,
          repoRoot: test.repoRoot,
        }),
        /failed or mutating case/,
      );
      await writeFile(safetyPath, safetyText);
      await resign(test);

      await assert.rejects(
        verifyRealBenchmarkArtifact({
          artifactRoot: test.root,
          runId: RUN_ID,
          expectedCommit: 'c'.repeat(40),
          integrityKey: INTEGRITY_KEY,
          repoRoot: test.repoRoot,
        }),
        /attestation identity does not match/,
      );
      await writeFile(join(test.runDirectory, 'results', 'extra.json'), '{}');
      await assert.rejects(
        verifyRealBenchmarkArtifact({
          artifactRoot: test.root,
          runId: RUN_ID,
          expectedCommit: test.commit,
          integrityKey: INTEGRITY_KEY,
          repoRoot: test.repoRoot,
        }),
        /missing, extra, or invalid files/,
      );
      await rm(join(test.runDirectory, 'results', 'extra.json'));
      const quotaPath = join(test.runDirectory, 'quota-preflight.json');
      const quota = JSON.parse(await readFile(quotaPath, 'utf8'));
      quota.results[0].status = 'unavailable';
      await writeFile(quotaPath, JSON.stringify(quota));
      await resign(test);
      await assert.rejects(
        verifyRealBenchmarkArtifact({
          artifactRoot: test.root,
          runId: RUN_ID,
          expectedCommit: test.commit,
          integrityKey: INTEGRITY_KEY,
          repoRoot: test.repoRoot,
        }),
        /not exactly ready\/restored/,
      );
      quota.results[0].status = 'ready';
      await writeFile(quotaPath, JSON.stringify(quota));
      await resign(test);
      const reportPath = join(test.runDirectory, 'report.json');
      const report = JSON.parse(await readFile(reportPath, 'utf8'));
      report.summary.completed = 19;
      await writeFile(reportPath, JSON.stringify(report));
      await resign(test);
      await assert.rejects(
        verifyRealBenchmarkArtifact({
          artifactRoot: test.root,
          runId: RUN_ID,
          expectedCommit: test.commit,
          integrityKey: INTEGRITY_KEY,
          repoRoot: test.repoRoot,
        }),
        /report diverges from recomputed canonical report/,
      );
    } finally {
      await cleanup(test);
    }
  }, 60_000);

  it('rejects a stale or modified attested core build before semantic verification', async () => {
    const test = await fixture();
    try {
      const corePath = join(test.repoRoot, 'packages', 'mcp-core', 'dist', 'index.js');
      await writeFile(corePath, `${await readFile(corePath, 'utf8')}\n// stale\n`, 'utf8');
      await assert.rejects(
        verifyRealBenchmarkArtifact({
          artifactRoot: test.root,
          runId: RUN_ID,
          expectedCommit: test.commit,
          integrityKey: INTEGRITY_KEY,
          repoRoot: test.repoRoot,
        }),
        /built core index\.js digest does not match/,
      );
    } finally {
      await cleanup(test);
    }
  });

  it('rejects a tampered relative core chunk before importing the validator', async () => {
    const test = await fixture();
    try {
      const chunkPath = join(test.repoRoot, 'packages', 'mcp-core', 'dist', 'chunk.js');
      await writeFile(chunkPath, `${await readFile(chunkPath, 'utf8')}\n// tampered\n`, 'utf8');
      await assert.rejects(
        verifyRealBenchmarkArtifact({
          artifactRoot: test.root,
          runId: RUN_ID,
          expectedCommit: test.commit,
          integrityKey: INTEGRITY_KEY,
          repoRoot: test.repoRoot,
        }),
        /built core chunk\.js digest does not match the benchmark manifest/,
      );
    } finally {
      await cleanup(test);
    }
  });

  it('rejects an extra top-level JavaScript file outside the attested graph', async () => {
    const test = await fixture();
    try {
      await writeFile(
        join(test.repoRoot, 'packages', 'mcp-server', 'dist', 'unexpected.js'),
        'export {};\n',
      );
      await assert.rejects(
        verifyRealBenchmarkArtifact({
          artifactRoot: test.root,
          runId: RUN_ID,
          expectedCommit: test.commit,
          integrityKey: INTEGRITY_KEY,
          repoRoot: test.repoRoot,
        }),
        /built CLI JavaScript graph has missing or extra files/,
      );
    } finally {
      await cleanup(test);
    }
  });

  it('rejects a result that is semantically bound to a different trial', async () => {
    const test = await fixture();
    try {
      const resultPath = join(test.runDirectory, 'results', 'trial-01.json');
      const value = JSON.parse(await readFile(resultPath, 'utf8'));
      value.mode = 'forced_resume';
      await writeFile(resultPath, JSON.stringify(value));
      await resign(test);
      await assert.rejects(
        verifyRealBenchmarkArtifact({
          artifactRoot: test.root,
          runId: RUN_ID,
          expectedCommit: test.commit,
          integrityKey: INTEGRITY_KEY,
          repoRoot: test.repoRoot,
        }),
        /mode does not match its manifest trial/,
      );
    } finally {
      await cleanup(test);
    }
  });

  it('rejects a re-signed result whose baseline fingerprint is bound to another guild', async () => {
    const test = await fixture();
    try {
      const resultPath = join(test.runDirectory, 'results', 'trial-01.json');
      const value = JSON.parse(await readFile(resultPath, 'utf8'));
      value.baseline_fingerprint_before = baselineFingerprintForGuild(CONTROLLED_GUILD_IDS[1]);
      value.baseline_fingerprint_after = baselineFingerprintForGuild(CONTROLLED_GUILD_IDS[1]);
      await writeFile(resultPath, JSON.stringify(value));
      await resign(test);
      await assert.rejects(
        verifyRealBenchmarkArtifact({
          artifactRoot: test.root,
          runId: RUN_ID,
          expectedCommit: test.commit,
          integrityKey: INTEGRITY_KEY,
          repoRoot: test.repoRoot,
        }),
        /baseline fingerprint does not match quota preflight/,
      );
    } finally {
      await cleanup(test);
    }
  });

  it('rejects a re-signed result whose full blueprint violates the production schema', async () => {
    const test = await fixture();
    try {
      const resultPath = join(test.runDirectory, 'results', 'trial-01.json');
      const value = JSON.parse(await readFile(resultPath, 'utf8'));
      value.activity_evidence.evidence_body.blueprint.roles[0].permissions.push('ADMINISTRATOR');
      value.activity_evidence.evidence_id = digest(value.activity_evidence.evidence_body);
      await writeFile(resultPath, JSON.stringify(value));
      await resign(test);
      await assert.rejects(
        verifyRealBenchmarkArtifact({
          artifactRoot: test.root,
          runId: RUN_ID,
          expectedCommit: test.commit,
          integrityKey: INTEGRITY_KEY,
          repoRoot: test.repoRoot,
        }),
        /Activity Evidence semantics are invalid/,
      );
    } finally {
      await cleanup(test);
    }
  });

  it('rejects re-signed results with extra or missing Activity Evidence envelope fields', async () => {
    const test = await fixture();
    try {
      const resultPath = join(test.runDirectory, 'results', 'trial-01.json');
      const original = await readFile(resultPath, 'utf8');
      for (const mutate of [
        (activity) => {
          activity.untrusted = true;
        },
        (activity) => {
          delete activity.safety_policy;
        },
      ]) {
        const value = JSON.parse(original);
        mutate(value.activity_evidence);
        await writeFile(resultPath, JSON.stringify(value));
        await resign(test);
        await assert.rejects(
          verifyRealBenchmarkArtifact({
            artifactRoot: test.root,
            runId: RUN_ID,
            expectedCommit: test.commit,
            integrityKey: INTEGRITY_KEY,
            repoRoot: test.repoRoot,
          }),
          /Activity Evidence outer envelope has unknown or missing fields/,
        );
      }
    } finally {
      await cleanup(test);
    }
  });

  it('rejects artifact tampering and the wrong caller-owned secret before trusting JSON', async () => {
    const test = await fixture();
    try {
      const resultPath = join(test.runDirectory, 'results', 'trial-01.json');
      await writeFile(resultPath, '{}');
      await assert.rejects(
        verifyRealBenchmarkArtifact({
          artifactRoot: test.root,
          runId: RUN_ID,
          expectedCommit: test.commit,
          integrityKey: INTEGRITY_KEY,
          repoRoot: test.repoRoot,
        }),
        /artifact digest check failed/,
      );
      await assert.rejects(
        verifyRealBenchmarkArtifact({
          artifactRoot: test.root,
          runId: RUN_ID,
          expectedCommit: test.commit,
          integrityKey: 'wrong-caller-secret',
          repoRoot: test.repoRoot,
        }),
        /HMAC check failed/,
      );
    } finally {
      await cleanup(test);
    }
  });

  it('rejects a file that is already over its bound before reading it', async () => {
    const test = await fixture();
    try {
      const manifestPath = join(test.runDirectory, 'manifest.json');
      await writeFile(manifestPath, Buffer.alloc(1024 * 1024 + 1, 0x20));
      const oversized = await stat(manifestPath);
      assert.equal(oversized.size, 1024 * 1024 + 1);
      await assert.rejects(
        verifyRealBenchmarkArtifact({
          artifactRoot: test.root,
          runId: RUN_ID,
          expectedCommit: test.commit,
          integrityKey: INTEGRITY_KEY,
          repoRoot: test.repoRoot,
        }),
        /manifest\.json is outside the size bound/,
      );
    } finally {
      await cleanup(test);
    }
  });
});
