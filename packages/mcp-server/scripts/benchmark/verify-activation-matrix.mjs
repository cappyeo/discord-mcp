#!/usr/bin/env node

import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertSecretFreeJson } from './manifest.mjs';
import {
  ACTIVATION_VERIFIER_SCHEMA,
  PRODUCTION_ACTIVATION_HOSTS,
  verifyProductionActivationMatrix,
} from './verify-activation-trials.mjs';

const RELEASE = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;
const COMMIT = /^[a-f0-9]{40}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const RUN_ID = /^[a-z0-9][a-z0-9._-]{2,127}$/;
const SNOWFLAKE = /^\d{17,20}$/;
const SHARED_FLAGS = new Map([
  ['--artifact-root', 'artifactRoot'],
  ['--expected-release', 'expectedRelease'],
  ['--expected-commit', 'expectedCommit'],
  ['--expected-build-digest', 'expectedBuildDigest'],
]);
const RUN_FLAGS = new Map(PRODUCTION_ACTIVATION_HOSTS.map((host) => [`--${host}-run-id`, host]));

export function parseActivationMatrixArgs(argv) {
  if (!Array.isArray(argv)) throw new TypeError('activation matrix arguments are invalid');
  const options = { runIds: {} };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if ((!SHARED_FLAGS.has(flag) && !RUN_FLAGS.has(flag)) || seen.has(flag))
      throw new TypeError('activation matrix arguments are invalid');
    const value = argv[++index];
    if (typeof value !== 'string' || value === '' || value.startsWith('--'))
      throw new TypeError('activation matrix arguments are invalid');
    seen.add(flag);
    if (SHARED_FLAGS.has(flag)) options[SHARED_FLAGS.get(flag)] = value;
    else options.runIds[RUN_FLAGS.get(flag)] = value;
  }
  if (
    typeof options.artifactRoot !== 'string' ||
    !isAbsolute(options.artifactRoot) ||
    !RELEASE.test(options.expectedRelease ?? '') ||
    !COMMIT.test(options.expectedCommit ?? '') ||
    !DIGEST.test(options.expectedBuildDigest ?? '') ||
    Object.keys(options.runIds).length !== PRODUCTION_ACTIVATION_HOSTS.length ||
    PRODUCTION_ACTIVATION_HOSTS.some((host) => !RUN_ID.test(options.runIds[host] ?? '')) ||
    new Set(Object.values(options.runIds)).size !== PRODUCTION_ACTIVATION_HOSTS.length
  ) {
    throw new TypeError('activation matrix arguments are invalid');
  }
  return options;
}

export function buildActivationMatrixCampaigns(artifactRoot, runIds) {
  if (typeof artifactRoot !== 'string' || !isAbsolute(artifactRoot))
    throw new TypeError('activation matrix artifact root must be absolute');
  const root = resolve(artifactRoot);
  return Object.fromEntries(
    PRODUCTION_ACTIVATION_HOSTS.map((host) => {
      const expectedRunId = runIds?.[host];
      if (!RUN_ID.test(expectedRunId ?? ''))
        throw new TypeError('activation matrix run id is invalid');
      return [
        host,
        {
          inputPath: join(root, 'runs', expectedRunId, 'results', 'activation-trials-bundle.json'),
          evidenceDir: join(root, 'activation-evidence', expectedRunId),
          expectedRunId,
        },
      ];
    }),
  );
}

function environmentToken(environment) {
  const value = environment.DISCORD_TESTBOT_B_TOKEN?.trim();
  const token = value?.startsWith('Bot ') ? value.slice(4).trim() : value;
  if (!token) throw new Error('activation matrix environment is incomplete');
  return token;
}

function publicFailure() {
  return {
    schema_version: ACTIVATION_VERIFIER_SCHEMA,
    verified: false,
    error: 'activation matrix verification failed',
  };
}

/** Verify five independently authenticated host campaigns and print no private evidence. */
export async function main({
  argv = process.argv.slice(2),
  environment = process.env,
  stdout = process.stdout,
  verify = verifyProductionActivationMatrix,
  validateActivityEvidence,
} = {}) {
  try {
    const options = parseActivationMatrixArgs(argv);
    const guildId = environment.DISCORD_ACTIVATION_GUILD_ID;
    const botId = environment.DISCORD_EXPECTED_BOT_ID;
    if (!SNOWFLAKE.test(guildId ?? '') || !SNOWFLAKE.test(botId ?? ''))
      throw new Error('activation matrix environment is incomplete');
    const token = environmentToken(environment);
    const validator =
      validateActivityEvidence ??
      (await import('@discord-mcp/core')).assertGuildBlueprintActivityEvidence;
    const result = await verify({
      campaigns: buildActivationMatrixCampaigns(options.artifactRoot, options.runIds),
      integrityKey: token,
      expectedBinding: { guildId, botId },
      expectedRelease: options.expectedRelease,
      expectedCommit: options.expectedCommit,
      expectedBuildDigest: options.expectedBuildDigest,
      validateActivityEvidence: validator,
    });
    assertSecretFreeJson(result, 'activation_matrix_verification');
    if (JSON.stringify(result).includes(token))
      throw new Error('activation matrix output contains the integrity key');
    stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch {
    stdout.write(`${JSON.stringify(publicFailure())}\n`);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => {
    process.exitCode = code;
  });
}
