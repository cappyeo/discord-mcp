#!/usr/bin/env node

import { lstat, open, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifySmallModelLiveArtifact } from './small-model-live-run.mjs';
import { assertBenchmarkSourceIntegrity } from './source-integrity.mjs';
import {
  assertBuiltArtifactsMatch,
  loadAttestedActivityValidator,
} from './verify-real-benchmark.mjs';

export const SMALL_MODEL_LIVE_VERIFIER_SCHEMA = 'discord-mcp.small-model-live-verifier.v1';

const COMMIT = /^[a-f0-9]{40}$/;
const RUN_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const MAX_ARTIFACT_BYTES = 4 * 1024 * 1024;
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = resolve(dirname(SCRIPT_PATH), '../../../..');

function within(parent, candidate) {
  const value = relative(parent, candidate);
  return value === '' || (!value.startsWith('..') && !isAbsolute(value));
}

function required(value, label) {
  if (typeof value !== 'string' || value === '') throw new TypeError(`${label} is required`);
  return value;
}

export function parseSmallModelLiveVerifierArgs(args) {
  const allowed = new Set(['--expected-commit', '--artifact-root', '--run-id']);
  const values = {};
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (!allowed.has(flag)) throw new TypeError(`unknown verifier argument: ${String(flag)}`);
    if (Object.hasOwn(values, flag)) throw new TypeError(`duplicate verifier argument: ${flag}`);
    const value = args[++index];
    if (typeof value !== 'string' || value === '' || value.startsWith('--'))
      throw new TypeError(`missing value for ${flag}`);
    values[flag] = value;
  }
  for (const flag of allowed)
    if (!Object.hasOwn(values, flag)) throw new TypeError(`missing verifier argument: ${flag}`);
  if (!COMMIT.test(values['--expected-commit']))
    throw new TypeError('--expected-commit must be a full lowercase Git SHA');
  if (!isAbsolute(values['--artifact-root']))
    throw new TypeError('--artifact-root must be absolute');
  if (!RUN_ID.test(values['--run-id'])) throw new TypeError('--run-id is invalid');
  return {
    expectedCommit: values['--expected-commit'],
    artifactRoot: values['--artifact-root'],
    runId: values['--run-id'],
  };
}

async function regularDirectory(path, label) {
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink())
    throw new Error(`${label} is not a regular directory`);
  return realpath(path);
}

async function readArtifact({ artifactRoot, runId, repoRoot }) {
  const sourceRoot = await realpath(repoRoot);
  const requestedRoot = resolve(artifactRoot);
  if (within(sourceRoot, requestedRoot))
    throw new Error('small-model live artifact root is inside the source repository');
  const root = await regularDirectory(requestedRoot, 'small-model live artifact root');
  if (within(sourceRoot, root))
    throw new Error('small-model live artifact root resolves inside the source repository');
  const runDirectory = await regularDirectory(
    resolve(root, 'runs', runId),
    'small-model live run directory',
  );
  if (!within(root, runDirectory)) throw new Error('small-model live run escaped artifact root');
  const resultsDirectory = await regularDirectory(
    resolve(runDirectory, 'results'),
    'small-model live results directory',
  );
  if (!within(runDirectory, resultsDirectory))
    throw new Error('small-model live results escaped its run');
  const path = resolve(resultsDirectory, 'small-model-live.json');
  const metadata = await lstat(path);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size < 2 ||
    metadata.size > MAX_ARTIFACT_BYTES
  )
    throw new Error('small-model live artifact is missing or outside the size bound');
  const handle = await open(path, 'r');
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size !== metadata.size)
      throw new Error('small-model live artifact changed while opening');
    const text = await handle.readFile({ encoding: 'utf8' });
    const final = await handle.stat();
    if (final.size !== metadata.size || Buffer.byteLength(text, 'utf8') !== final.size)
      throw new Error('small-model live artifact changed while reading');
    try {
      return JSON.parse(text);
    } catch {
      throw new Error('small-model live artifact is not valid JSON');
    }
  } finally {
    await handle.close();
  }
}

export async function verifySmallModelLiveRun({
  artifactRoot,
  runId,
  expectedCommit,
  integrityKey,
  repoRoot = REPOSITORY_ROOT,
  sourceIntegrity = assertBenchmarkSourceIntegrity,
  builtArtifacts = assertBuiltArtifactsMatch,
  loadValidator = loadAttestedActivityValidator,
} = {}) {
  required(integrityKey, 'integrityKey');
  if (!COMMIT.test(required(expectedCommit, 'expectedCommit')))
    throw new TypeError('expectedCommit must be a full lowercase Git SHA');
  if (!RUN_ID.test(required(runId, 'runId'))) throw new TypeError('runId is invalid');
  if (!isAbsolute(required(artifactRoot, 'artifactRoot')))
    throw new TypeError('artifactRoot must be absolute');
  await sourceIntegrity({ cwd: repoRoot, expectedCommit });
  const artifact = await readArtifact({ artifactRoot, runId, repoRoot });
  const verifiedBuild = await builtArtifacts({ built_cli: artifact.built_cli }, repoRoot);
  const validateActivityEvidence = await loadValidator(verifiedBuild.coreArtifact, repoRoot);
  const verified = verifySmallModelLiveArtifact({
    artifact,
    integrityKey,
    expectedCommit,
    validateActivityEvidence,
  });
  return {
    schema_version: SMALL_MODEL_LIVE_VERIFIER_SCHEMA,
    verified: true,
    expected_commit: expectedCommit,
    target: verified.summary.target,
    model: verified.summary.model,
    request: verified.summary.request,
    operation_count: verified.summary.plan.operation_count,
    evidence_id: verified.summary.evidence.evidence_id,
    baseline_restored: verified.restored,
  };
}

function token(environment) {
  const raw = environment.DISCORD_TESTBOT_B_TOKEN;
  if (typeof raw !== 'string' || raw.trim() === '')
    throw new Error('DISCORD_TESTBOT_B_TOKEN is required');
  const value = raw.trim();
  return value.startsWith('Bot ') ? value.slice(4) : value;
}

export async function main(args = process.argv.slice(2), environment = process.env) {
  const options = parseSmallModelLiveVerifierArgs(args);
  const result = await verifySmallModelLiveRun({ ...options, integrityKey: token(environment) });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return result;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === SCRIPT_PATH) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
