import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, open, readdir, realpath, rm, rmdir } from 'node:fs/promises';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  posix as posixPath,
  relative,
  resolve,
} from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CONTROLLED_BOT_ID, CONTROLLED_GUILD_IDS } from './campaign.mjs';
import { verifyCampaignAttestation } from './campaign-attestation.mjs';
import {
  assertBenchmarkManifest,
  assertSecretFreeJson,
  canonicalJson,
  createBenchmarkReport,
} from './manifest.mjs';
import { assertBenchmarkSourceIntegrity } from './source-integrity.mjs';

const RUN_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const SNOWFLAKE = /^\d{17,20}$/;
const TRIAL_ID = /^[a-zA-Z0-9._-]+$/;
const QUOTA_POOL_SCHEMA = 'discord-mcp.benchmark-quota-preflight-pool.v1';
const QUOTA_SCHEMA = 'discord-mcp.benchmark-quota-preflight.v1';
const MAX_MANIFEST_BYTES = 1 * 1024 * 1024;
const MAX_CONTROL_ARTIFACT_BYTES = 1 * 1024 * 1024;
const MAX_RESULT_BYTES = 10 * 1024 * 1024;
const MAX_REPORT_BYTES = 50 * 1024 * 1024;
const MAX_BUILT_CLI_BYTES = 50 * 1024 * 1024;
const MAX_BUILT_GRAPH_FILES = 256;
const MAX_BUILT_GRAPH_TOTAL_BYTES = 100 * 1024 * 1024;
const BUILT_GRAPH_PREFIXES = Object.freeze({
  cli: 'packages/mcp-server/dist/',
  core: 'packages/mcp-core/dist/',
});
const RELATIVE_MODULE_RE = /\b(?:from|import)\s*(?:\(\s*)?["'](\.[^"']+)["']/g;
const QUOTA_POOL_FIELDS = new Set(['schema_version', 'results']);
const RESULT_FILES = new Set([
  'attestation.json',
  'manifest.json',
  'quota-preflight.json',
  'safety-cases.json',
  'report.json',
]);
const RUN_DIRECTORIES = new Set(['results', 'state']);
const QUOTA_FIELDS = new Set([
  'schema_version',
  'guild_id',
  'bot_id',
  'status',
  'create_attempts',
  'waited_ms',
  'retry_after_ms',
  'role_id',
  'baseline_fingerprint_before',
  'baseline_fingerprint_after',
  'baseline_restored',
]);
const SAFETY_FIELDS = new Set([
  'case',
  'passed',
  'guard_guild_id',
  'target_guild_id',
  'active_bot_id',
  'supplied_bot_id',
  'blocked_before_discord',
  'blocker_code',
  'plan_status',
  'target_readback',
  'operations_planned',
  'snapshot_unchanged',
  'audit_entry_count',
  'mutation_count',
]);
const ACTIVITY_EVIDENCE_FIELDS = new Set([
  'schema_version',
  'evidence_id',
  'recorded_at',
  'digest_verified',
  'plan_id',
  'blueprint_id',
  'target',
  'initial_snapshot_id',
  'final_snapshot_id',
  'current_snapshot_id',
  'initial_operation_count',
  'checkpoint_version',
  'completed_operation_count',
  'blueprint_readback_match',
  'identity_verified',
  'guild_verified',
  'readback',
  'snapshot_unchanged',
  'evidence_body',
  'expected_counts',
  'blueprint_counts',
  'safety_policy',
]);

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function within(root, target) {
  const path = relative(root, target);
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}

async function assertNoSymlinkPath(path, label) {
  let current = resolve(path);
  while (true) {
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        throw new Error(`${label} contains a symlink`);
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

async function existingDirectory(path, label) {
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink())
    throw new Error(`${label} is not a directory`);
  await assertNoSymlinkPath(path, label);
}

async function readJson(path, label, maxBytes, expectedDigest) {
  await assertNoSymlinkPath(path, label);
  const pathMetadata = await lstat(path);
  if (!pathMetadata.isFile() || pathMetadata.isSymbolicLink())
    throw new Error(`${label} is not a regular file`);
  if (pathMetadata.size < 2 || pathMetadata.size > maxBytes) {
    throw new Error(`${label} is outside the size bound`);
  }

  // Keep the descriptor open across the identity check and bounded read. The
  // initial lstat is intentionally retained as a cheap pre-read size gate;
  // fstat then closes the common path-replacement race before reading bytes.
  const handle = await open(path, 'r');
  try {
    const openedMetadata = await handle.stat();
    if (
      !openedMetadata.isFile() ||
      openedMetadata.isSymbolicLink() ||
      openedMetadata.dev !== pathMetadata.dev ||
      openedMetadata.ino !== pathMetadata.ino
    ) {
      throw new Error(`${label} changed while opening`);
    }
    if (openedMetadata.size < 2 || openedMetadata.size > maxBytes) {
      throw new Error(`${label} is outside the size bound`);
    }

    // Read at most maxBytes + 1 bytes, so growth after fstat cannot make the
    // verifier consume an unbounded artifact. A loop handles short reads.
    const bytes = Buffer.alloc(maxBytes + 1);
    let bytesRead = 0;
    while (bytesRead < bytes.length) {
      const read = await handle.read(bytes, bytesRead, bytes.length - bytesRead, bytesRead);
      bytesRead += read.bytesRead;
      if (read.bytesRead === 0) break;
    }
    const finalMetadata = await handle.stat();
    if (finalMetadata.size > maxBytes || bytesRead < 2 || bytesRead > maxBytes) {
      throw new Error(`${label} is outside the size bound`);
    }
    if (finalMetadata.size !== bytesRead) {
      throw new Error(`${label} changed while reading`);
    }

    const exactBytes = bytes.subarray(0, bytesRead);
    const digest = `sha256:${createHash('sha256').update(exactBytes).digest('hex')}`;
    if (digest !== expectedDigest) {
      throw new Error(`${label} does not match the authenticated campaign bytes`);
    }
    const text = exactBytes.toString('utf8');
    if (text.trim() === '') throw new Error(`${label} is empty`);
    let value;
    try {
      value = JSON.parse(text);
    } catch {
      throw new Error(`${label} is not valid JSON`);
    }
    assertSecretFreeJson(value, label);
    return value;
  } finally {
    await handle.close();
  }
}

async function assertBuiltArtifactsMatch(manifest, repoRoot) {
  const sourceRoot = await realpath(repoRoot);
  const verify = async (entrypoint, expectedDigest, label) => {
    const candidate = resolve(sourceRoot, entrypoint);
    if (!within(sourceRoot, candidate)) throw new Error(`${label} escaped the source repository`);
    await assertNoSymlinkPath(candidate, label);
    const metadata = await lstat(candidate);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.size < 1 ||
      metadata.size > MAX_BUILT_CLI_BYTES
    ) {
      throw new Error(`${label} is missing or outside the size bound`);
    }
    const handle = await open(candidate, 'r');
    try {
      const opened = await handle.stat();
      if (
        !opened.isFile() ||
        opened.dev !== metadata.dev ||
        opened.ino !== metadata.ino ||
        opened.size !== metadata.size
      ) {
        throw new Error(`${label} changed while opening`);
      }
      const hash = createHash('sha256');
      const buffer = Buffer.alloc(64 * 1024);
      const chunks = [];
      let total = 0;
      while (true) {
        const read = await handle.read(buffer, 0, buffer.length, null);
        if (read.bytesRead === 0) break;
        const chunk = buffer.subarray(0, read.bytesRead);
        total += read.bytesRead;
        if (total > MAX_BUILT_CLI_BYTES) throw new Error(`${label} is outside the size bound`);
        hash.update(chunk);
        chunks.push(Buffer.from(chunk));
      }
      const final = await handle.stat();
      if (
        final.dev !== metadata.dev ||
        final.ino !== metadata.ino ||
        final.size !== total ||
        total < 1
      ) {
        throw new Error(`${label} changed while reading`);
      }
      const digest = `sha256:${hash.digest('hex')}`;
      if (digest !== expectedDigest) {
        throw new Error(`${label} digest does not match the benchmark manifest`);
      }
      return {
        path: await realpath(candidate),
        bytes: Buffer.concat(chunks, total),
        sha256: digest,
      };
    } finally {
      await handle.close();
    }
  };

  const listActualGraph = async (outputDirectory, label) => {
    const directory = resolve(sourceRoot, outputDirectory);
    await assertNoSymlinkPath(directory, `${label} output directory`);
    const metadata = await lstat(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error(`${label} output directory is not a regular directory`);
    }
    const entries = await readdir(directory, { withFileTypes: true });
    const paths = [];
    for (const entry of entries) {
      if (!entry.name.endsWith('.js')) continue;
      if (entry.isSymbolicLink() || !entry.isFile()) {
        throw new Error(`${label} graph contains an invalid JavaScript entry`);
      }
      paths.push(posixPath.join(outputDirectory.replaceAll('\\', '/'), entry.name));
    }
    paths.sort();
    if (paths.length < 1 || paths.length > MAX_BUILT_GRAPH_FILES) {
      throw new Error(`${label} JavaScript graph has an invalid file count`);
    }
    return paths;
  };

  const verifyGraph = async ({ files, outputDirectory, label }) => {
    const expectedPaths = files.map((file) => file.path);
    const actualPaths = await listActualGraph(outputDirectory, label);
    if (canonicalJson(expectedPaths) !== canonicalJson(actualPaths)) {
      throw new Error(`${label} JavaScript graph has missing or extra files`);
    }
    let totalBytes = 0;
    const verifiedFiles = [];
    for (const file of files) {
      const artifact = await verify(file.path, file.sha256, `${label} ${basename(file.path)}`);
      totalBytes += artifact.bytes.length;
      if (totalBytes > MAX_BUILT_GRAPH_TOTAL_BYTES) {
        throw new Error(`${label} JavaScript graph exceeds the total size bound`);
      }
      verifiedFiles.push({
        path: file.path,
        sha256: artifact.sha256,
        bytes: artifact.bytes,
        absolutePath: artifact.path,
      });
    }
    assertAttestedRelativeGraph(
      verifiedFiles,
      label === 'built core' ? BUILT_GRAPH_PREFIXES.core : BUILT_GRAPH_PREFIXES.cli,
      label,
    );
    return { files: verifiedFiles };
  };

  const cli = await verifyGraph({
    files: manifest.built_cli.files,
    outputDirectory: BUILT_GRAPH_PREFIXES.cli.slice(0, -1),
    label: 'built CLI',
  });
  const core = await verifyGraph({
    files: manifest.built_cli.core_files,
    outputDirectory: BUILT_GRAPH_PREFIXES.core.slice(0, -1),
    label: 'built core',
  });
  return {
    cliArtifact: {
      entrypoint: manifest.built_cli.entrypoint,
      sha256: manifest.built_cli.sha256,
      files: cli.files,
    },
    coreArtifact: {
      entrypoint: manifest.built_cli.core_entrypoint,
      sha256: manifest.built_cli.core_sha256,
      files: core.files,
      path: core.files.find((file) => file.path === manifest.built_cli.core_entrypoint)
        .absolutePath,
    },
  };
}

function relativeModuleSpecifiers(bytes) {
  const source = bytes.toString('utf8');
  const specifiers = new Set();
  for (const match of source.matchAll(RELATIVE_MODULE_RE)) specifiers.add(match[1]);
  return [...specifiers];
}

async function writePrivateCopy(path, bytes) {
  const handle = await open(path, 'wx', 0o600);
  try {
    let offset = 0;
    while (offset < bytes.length) {
      const written = await handle.write(bytes, offset, bytes.length - offset, null);
      if (written.bytesWritten < 1) throw new Error('attested core copy write made no progress');
      offset += written.bytesWritten;
    }
    await handle.sync();
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size !== bytes.length) {
      throw new Error('attested core copy changed while writing');
    }
  } finally {
    await handle.close();
  }
}

function attestedLocalPath(filePath, prefix) {
  if (!filePath.startsWith(prefix)) throw new Error('attested module path is outside its graph');
  return filePath.slice(prefix.length);
}

function resolveAttestedRelativePath(sourcePath, specifier) {
  const resolved = posixPath.normalize(posixPath.join(posixPath.dirname(sourcePath), specifier));
  if (resolved === '..' || resolved.startsWith('../') || resolved.startsWith('/')) return null;
  return resolved;
}

function assertAttestedRelativeGraph(files, prefix, label) {
  const byLocalPath = new Map(files.map((file) => [attestedLocalPath(file.path, prefix), file]));
  for (const file of files) {
    const localPath = attestedLocalPath(file.path, prefix);
    for (const specifier of relativeModuleSpecifiers(file.bytes)) {
      const dependencyPath = resolveAttestedRelativePath(localPath, specifier);
      if (dependencyPath === null || !byLocalPath.has(dependencyPath)) {
        throw new Error(`${label} relative import is outside the attested graph: ${specifier}`);
      }
    }
  }
  return byLocalPath;
}

function assertAttestedCoreGraph(coreArtifact) {
  return assertAttestedRelativeGraph(coreArtifact.files, BUILT_GRAPH_PREFIXES.core, 'built core');
}

async function createAttestedCoreCopy({ coreArtifact, repoRoot }) {
  const packageRoot = dirname(dirname(coreArtifact.path));
  if (!within(repoRoot, packageRoot))
    throw new Error('attested core package escaped the repository');
  const privateDirectory = await mkdtemp(join(packageRoot, '.discord-mcp-attested-core-'));
  const copiedFiles = [];
  const copiedDirectories = new Set();
  try {
    await chmod(privateDirectory, 0o700);
    const localFiles = assertAttestedCoreGraph(coreArtifact);
    const copy = async (targetPath, bytes) => {
      if (!within(privateDirectory, targetPath))
        throw new Error('attested core copy escaped its directory');
      await mkdir(dirname(targetPath), { recursive: true, mode: 0o700 });
      await writePrivateCopy(targetPath, bytes);
      copiedFiles.push(targetPath);
      let targetDirectory = dirname(targetPath);
      while (targetDirectory !== privateDirectory) {
        copiedDirectories.add(targetDirectory);
        targetDirectory = dirname(targetDirectory);
      }
    };
    for (const file of coreArtifact.files) {
      await copy(join(privateDirectory, basename(file.path)), file.bytes);
    }
    const entryFile = localFiles.get(
      attestedLocalPath(coreArtifact.entrypoint, BUILT_GRAPH_PREFIXES.core),
    );
    if (!entryFile) throw new Error('attested core entrypoint is not present in its graph');
    const contentAddressedPath = join(privateDirectory, `${coreArtifact.sha256.slice(7)}.mjs`);
    await copy(contentAddressedPath, entryFile.bytes);
    return {
      entrypoint: contentAddressedPath,
      directory: privateDirectory,
      files: copiedFiles,
      directories: [...copiedDirectories].sort((left, right) => right.length - left.length),
    };
  } catch (error) {
    await cleanupAttestedCoreCopy({
      directory: privateDirectory,
      files: copiedFiles,
      directories: [...copiedDirectories].sort((left, right) => right.length - left.length),
    });
    throw error;
  }
}

async function cleanupAttestedCoreCopy({ directory, files, directories }) {
  for (const path of [...files].reverse()) await rm(path, { force: true });
  for (const path of directories) await rm(path, { force: true });
  const metadata = await lstat(directory).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (metadata?.isDirectory() && !metadata.isSymbolicLink()) {
    await rmdir(directory);
  }
}

export async function loadAttestedActivityValidator(coreArtifact, repoRoot) {
  const copy = await createAttestedCoreCopy({ coreArtifact, repoRoot });
  try {
    const module = await import(
      `${pathToFileURL(copy.entrypoint).href}?benchmark_attestation=${coreArtifact.sha256.slice(7)}`
    );
    if (typeof module.assertGuildBlueprintActivityEvidence !== 'function') {
      throw new Error('attested core validator export is missing');
    }
    return module.assertGuildBlueprintActivityEvidence;
  } catch {
    throw new Error('attested core validator could not be loaded');
  } finally {
    await cleanupAttestedCoreCopy(copy);
  }
}

function assertRunId(value) {
  if (typeof value !== 'string' || !RUN_ID.test(value)) throw new TypeError('run-id is invalid');
}

function assertCommit(value) {
  if (typeof value !== 'string' || !COMMIT.test(value))
    throw new TypeError('expected-commit must be a full commit SHA');
}

function assertControlledManifest(manifest, runId, expectedCommit) {
  assertBenchmarkManifest(manifest);
  if (manifest.run_id !== runId) throw new Error('manifest run_id does not match requested run-id');
  if (manifest.commit !== expectedCommit)
    throw new Error('manifest commit does not match expected commit');
  if (manifest.trials.length !== 20) throw new Error('manifest must contain exactly 20 trials');
  if (manifest.trials.some((trial) => !TRIAL_ID.test(trial.trial_id))) {
    throw new Error('manifest contains an unsafe trial ID');
  }
  if (manifest.trials.some((trial) => trial.expected_bot_id !== CONTROLLED_BOT_ID)) {
    throw new Error('manifest contains a non-controlled bot target');
  }
  for (const guildId of CONTROLLED_GUILD_IDS) {
    const trials = manifest.trials.filter((trial) => trial.guild_id === guildId);
    if (
      trials.length !== 10 ||
      trials.filter((trial) => trial.mode === 'full').length !== 5 ||
      trials.filter((trial) => trial.mode === 'forced_resume').length !== 5
    ) {
      throw new Error(
        'manifest must contain exactly 5 full and 5 forced trials per controlled guild',
      );
    }
  }
  const guilds = new Set(manifest.trials.map((trial) => trial.guild_id));
  if (
    guilds.size !== CONTROLLED_GUILD_IDS.length ||
    CONTROLLED_GUILD_IDS.some((id) => !guilds.has(id))
  ) {
    throw new Error('manifest guilds do not match the controlled pool');
  }
}

function assertQuotaPreflight(value) {
  if (
    !record(value) ||
    value.schema_version !== QUOTA_POOL_SCHEMA ||
    !Array.isArray(value.results) ||
    Object.keys(value).some((key) => !QUOTA_POOL_FIELDS.has(key))
  ) {
    throw new Error('quota preflight artifact is malformed');
  }
  if (value.results.length !== CONTROLLED_GUILD_IDS.length) {
    throw new Error('quota preflight must contain exactly two controlled targets');
  }
  const seen = new Set();
  for (const item of value.results) {
    if (
      !record(item) ||
      Object.keys(item).length !== QUOTA_FIELDS.size ||
      Object.keys(item).some((key) => !QUOTA_FIELDS.has(key))
    ) {
      throw new Error('quota preflight record is malformed');
    }
    if (
      item.schema_version !== QUOTA_SCHEMA ||
      !CONTROLLED_GUILD_IDS.includes(item.guild_id) ||
      item.bot_id !== CONTROLLED_BOT_ID ||
      seen.has(item.guild_id) ||
      item.status !== 'ready' ||
      !Number.isSafeInteger(item.create_attempts) ||
      item.create_attempts < 1 ||
      item.create_attempts > 2 ||
      !Number.isSafeInteger(item.waited_ms) ||
      item.waited_ms < 0 ||
      (item.retry_after_ms !== null &&
        (!Number.isSafeInteger(item.retry_after_ms) || item.retry_after_ms < 0)) ||
      !SNOWFLAKE.test(item.role_id ?? '') ||
      !/^sha256:[a-f0-9]{64}$/.test(item.baseline_fingerprint_before ?? '') ||
      item.baseline_fingerprint_after !== item.baseline_fingerprint_before ||
      item.baseline_restored !== true
    ) {
      throw new Error('quota preflight is not exactly ready/restored for the controlled targets');
    }
    seen.add(item.guild_id);
  }
  if (seen.size !== CONTROLLED_GUILD_IDS.length)
    throw new Error('quota preflight targets are incomplete');
}

function assertSafetyCases(value) {
  if (!Array.isArray(value) || value.length !== 3)
    throw new Error('safety-cases artifact must contain three cases');
  const cases = new Map(value.map((item) => [item?.case, item]));
  if (
    cases.size !== 3 ||
    ['wrong_bot', 'wrong_guild', 'write_preview'].some((name) => !cases.has(name))
  ) {
    throw new Error('safety-cases artifact is incomplete');
  }
  if (
    value.some(
      (item) =>
        !record(item) ||
        Object.keys(item).length !== SAFETY_FIELDS.size ||
        Object.keys(item).some((key) => !SAFETY_FIELDS.has(key)),
    )
  ) {
    throw new Error('safety-cases artifact contains unknown or missing fields');
  }
  if (
    value.some(
      (item) =>
        item.passed !== true ||
        item.snapshot_unchanged !== true ||
        item.audit_entry_count !== 0 ||
        item.mutation_count !== 0,
    )
  ) {
    throw new Error('safety-cases artifact contains a failed or mutating case');
  }
  const [firstGuild, secondGuild] = CONTROLLED_GUILD_IDS;
  const wrongBot = cases.get('wrong_bot');
  if (
    wrongBot.guard_guild_id !== wrongBot.target_guild_id ||
    !CONTROLLED_GUILD_IDS.includes(wrongBot.guard_guild_id) ||
    wrongBot.active_bot_id !== CONTROLLED_BOT_ID ||
    wrongBot.supplied_bot_id === CONTROLLED_BOT_ID ||
    wrongBot.blocked_before_discord !== true ||
    wrongBot.blocker_code !== 'EXPECTED_BOT_MISMATCH' ||
    wrongBot.plan_status !== 'blocked' ||
    wrongBot.target_readback !== 'not_run' ||
    wrongBot.operations_planned !== 0
  )
    throw new Error('wrong_bot safety case does not prove the exact guard');
  const wrongGuild = cases.get('wrong_guild');
  if (
    wrongGuild.guard_guild_id !== firstGuild ||
    wrongGuild.target_guild_id !== secondGuild ||
    wrongGuild.active_bot_id !== CONTROLLED_BOT_ID ||
    wrongGuild.supplied_bot_id !== CONTROLLED_BOT_ID ||
    wrongGuild.blocked_before_discord !== true ||
    wrongGuild.blocker_code !== 'GUILD_NOT_ALLOWED' ||
    wrongGuild.plan_status !== 'blocked' ||
    wrongGuild.target_readback !== 'not_run' ||
    wrongGuild.operations_planned !== 0
  )
    throw new Error('wrong_guild safety case does not prove the exact guard');
  const preview = cases.get('write_preview');
  if (
    preview.guard_guild_id !== preview.target_guild_id ||
    !CONTROLLED_GUILD_IDS.includes(preview.guard_guild_id) ||
    preview.active_bot_id !== CONTROLLED_BOT_ID ||
    preview.supplied_bot_id !== CONTROLLED_BOT_ID ||
    preview.blocked_before_discord !== false ||
    preview.blocker_code !== null ||
    preview.plan_status !== 'ready' ||
    preview.target_readback !== 'passed' ||
    preview.operations_planned <= 0
  )
    throw new Error('write_preview safety case does not prove a readback-only preview');
}

function assertControlledResultIdentity(result, trial, quotaByGuild) {
  if (!record(result)) throw new Error(`result ${trial.trial_id} must be a JSON object`);
  if (result.trial_id !== trial.trial_id)
    throw new Error(`result ${trial.trial_id} trial_id does not match its filename and manifest`);
  if (result.mode !== trial.mode) {
    throw new Error(`result ${trial.trial_id} mode does not match its manifest trial`);
  }
  if (result.guild_id !== trial.guild_id) {
    throw new Error(`result ${trial.trial_id} guild_id does not match its manifest trial`);
  }
  const quota = quotaByGuild.get(trial.guild_id);
  if (quota === undefined) {
    throw new Error(`result ${trial.trial_id} guild is missing from quota preflight`);
  }
  if (
    result.baseline_fingerprint_before !== quota.baseline_fingerprint_before ||
    result.baseline_fingerprint_after !== quota.baseline_fingerprint_after
  ) {
    throw new Error(
      `result ${trial.trial_id} baseline fingerprint does not match quota preflight for guild ${trial.guild_id}`,
    );
  }
  if (record(result.activity_evidence)) {
    if (
      result.activity_evidence.target?.guild_id !== trial.guild_id ||
      result.activity_evidence.target?.bot_id !== trial.expected_bot_id
    ) {
      throw new Error(`result ${trial.trial_id} activity evidence target does not match its trial`);
    }
  }
}

function activityBlueprintCounts(blueprint) {
  return {
    roles: blueprint.roles.length,
    categories: blueprint.categories.length,
    channels: blueprint.channels.length,
    automod_rules: blueprint.automod.rules.length,
    publications: blueprint.components_v2.publications.length,
    onboarding_prompts: blueprint.onboarding.prompts.length,
    onboarding_options: blueprint.onboarding.prompts.reduce(
      (total, prompt) => total + prompt.options.length,
      0,
    ),
  };
}

function assertActivityEvidenceSemantics(result, trial, assertEvidence) {
  const activity = result.activity_evidence;
  if (!record(activity)) {
    throw new Error(`result ${trial.trial_id} is missing Activity Evidence`);
  }
  if (
    Object.keys(activity).length !== ACTIVITY_EVIDENCE_FIELDS.size ||
    Object.keys(activity).some((key) => !ACTIVITY_EVIDENCE_FIELDS.has(key))
  ) {
    throw new Error(
      `result ${trial.trial_id} Activity Evidence outer envelope has unknown or missing fields`,
    );
  }
  if (!record(activity.evidence_body)) {
    throw new Error(`result ${trial.trial_id} is missing Activity Evidence`);
  }
  const evidence = {
    ...activity.evidence_body,
    evidence_id: activity.evidence_id,
  };
  try {
    assertEvidence(evidence);
  } catch {
    throw new Error(`result ${trial.trial_id} Activity Evidence semantics are invalid`);
  }

  const body = activity.evidence_body;
  const observed = body.observed;
  const invariants = body.plan_invariants;
  const summaryMatchesBody =
    activity.recorded_at === body.recorded_at &&
    activity.plan_id === body.plan_id &&
    activity.blueprint_id === body.blueprint_id &&
    canonicalJson(activity.target) === canonicalJson(body.target) &&
    activity.initial_snapshot_id === observed.initial_snapshot_id &&
    activity.final_snapshot_id === observed.final_snapshot_id &&
    activity.initial_operation_count === body.initial_operation_count &&
    activity.checkpoint_version === observed.checkpoint_version &&
    activity.completed_operation_count === observed.completed_operation_ids.length &&
    activity.blueprint_readback_match === observed.blueprint_readback_match &&
    canonicalJson(activity.expected_counts) === canonicalJson(invariants.expected_counts) &&
    canonicalJson(activity.safety_policy) === canonicalJson(invariants.safety_policy) &&
    canonicalJson(activity.blueprint_counts) ===
      canonicalJson(activityBlueprintCounts(body.blueprint));
  if (!summaryMatchesBody) {
    throw new Error(`result ${trial.trial_id} Activity Evidence summary diverges from its body`);
  }
}

async function resolveRunDirectory({ artifactRoot, runId, repoRoot }) {
  if (!isAbsolute(artifactRoot)) throw new TypeError('artifact-root must be an absolute path');
  await assertNoSymlinkPath(artifactRoot, 'benchmark artifact root');
  const sourceRoot = await realpath(repoRoot);
  const requestedRoot = resolve(artifactRoot);
  if (within(sourceRoot, requestedRoot))
    throw new Error('benchmark artifact root is inside the source repository');
  const root = await realpath(requestedRoot);
  if (within(sourceRoot, root))
    throw new Error('benchmark artifact root resolves inside the source repository');
  const runDirectory = join(root, 'runs', runId);
  if (!within(root, runDirectory)) throw new Error('run directory escaped artifact root');
  await existingDirectory(runDirectory, 'benchmark run directory');
  await existingDirectory(join(runDirectory, 'results'), 'artifact results directory');
  return { root, runDirectory };
}

async function assertLayout(runDirectory) {
  const entries = await readdir(runDirectory, { withFileTypes: true });
  for (const name of RESULT_FILES) {
    const entry = entries.find((candidate) => candidate.name === name);
    if (!entry?.isFile() || entry?.isSymbolicLink()) throw new Error(`missing or invalid ${name}`);
  }
  const resultsEntry = entries.find((entry) => entry.name === 'results');
  if (!resultsEntry?.isDirectory() || resultsEntry.isSymbolicLink()) {
    throw new Error('missing or invalid results directory');
  }
  for (const entry of entries) {
    if (RESULT_FILES.has(entry.name)) continue;
    if (!RUN_DIRECTORIES.has(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error(`unexpected run artifact ${entry.name}`);
    }
  }
  const allowedCount =
    RESULT_FILES.size + 1 + (entries.some((entry) => entry.name === 'state') ? 1 : 0);
  if (entries.length !== allowedCount) {
    throw new Error('run artifact layout contains missing or extra entries');
  }
}

export async function verifyRealBenchmarkArtifact({
  artifactRoot,
  runId,
  expectedCommit,
  integrityKey,
  repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..'),
  loadValidator = loadAttestedActivityValidator,
} = {}) {
  assertRunId(runId);
  assertCommit(expectedCommit);
  const { runDirectory } = await resolveRunDirectory({ artifactRoot, runId, repoRoot });
  await assertLayout(runDirectory);
  const attestation = await verifyCampaignAttestation({
    runDirectory,
    runId,
    commit: expectedCommit,
    integrityKey,
  });
  const manifest = await readJson(
    join(runDirectory, 'manifest.json'),
    'manifest.json',
    MAX_MANIFEST_BYTES,
    attestation.artifacts['manifest.json'],
  );
  assertControlledManifest(manifest, runId, expectedCommit);
  if (manifest.built_cli.core_source_commit !== manifest.commit) {
    throw new Error('built core source commit does not match the manifest commit');
  }
  await assertBenchmarkSourceIntegrity({ cwd: repoRoot, expectedCommit });
  const builtArtifacts = await assertBuiltArtifactsMatch(manifest, repoRoot);
  const assertEvidence = await loadValidator(builtArtifacts.coreArtifact, repoRoot);
  const quota = await readJson(
    join(runDirectory, 'quota-preflight.json'),
    'quota-preflight.json',
    MAX_CONTROL_ARTIFACT_BYTES,
    attestation.artifacts['quota-preflight.json'],
  );
  assertQuotaPreflight(quota);
  const safetyCases = await readJson(
    join(runDirectory, 'safety-cases.json'),
    'safety-cases.json',
    MAX_CONTROL_ARTIFACT_BYTES,
    attestation.artifacts['safety-cases.json'],
  );
  assertSafetyCases(safetyCases);

  const resultsDirectory = join(runDirectory, 'results');
  const quotaByGuild = new Map(quota.results.map((item) => [item.guild_id, item]));
  const resultEntries = await readdir(resultsDirectory, { withFileTypes: true });
  const expectedIds = new Set(manifest.trials.map((trial) => trial.trial_id));
  if (
    resultEntries.length !== expectedIds.size ||
    resultEntries.some(
      (entry) => entry.isSymbolicLink() || !entry.isFile() || !entry.name.endsWith('.json'),
    )
  )
    throw new Error('results directory contains missing, extra, or invalid files');
  const resultNames = new Set(resultEntries.map((entry) => entry.name.slice(0, -'.json'.length)));
  if (
    resultNames.size !== expectedIds.size ||
    [...resultNames].some((id) => !expectedIds.has(id))
  ) {
    throw new Error('results files do not exactly match manifest trial IDs');
  }
  const orderedResults = [];
  for (const trial of manifest.trials) {
    const result = await readJson(
      join(resultsDirectory, `${trial.trial_id}.json`),
      `result ${trial.trial_id}`,
      MAX_RESULT_BYTES,
      attestation.artifacts[`results/${trial.trial_id}.json`],
    );
    assertControlledResultIdentity(result, trial, quotaByGuild);
    assertActivityEvidenceSemantics(result, trial, assertEvidence);
    orderedResults.push(result);
  }
  const report = await readJson(
    join(runDirectory, 'report.json'),
    'report.json',
    MAX_REPORT_BYTES,
    attestation.artifacts['report.json'],
  );
  const recomputed = createBenchmarkReport(manifest, orderedResults, safetyCases);
  if (canonicalJson(report) !== canonicalJson(recomputed))
    throw new Error('report diverges from recomputed canonical report');
  if (recomputed.summary.gate_passed !== true)
    throw new Error('benchmark report gate is not passed');
  return {
    ok: true,
    run_id: manifest.run_id,
    commit: manifest.commit,
    trial_count: recomputed.trial_count,
    request: manifest.request,
    not_before: manifest.not_before,
    started_at: manifest.started_at,
    completed: recomputed.summary.completed,
    eligible: recomputed.summary.eligible,
    success_rate: recomputed.summary.success_rate,
    serious_permission_failures: recomputed.summary.serious_permission_failures,
    safety_cases_passed: recomputed.summary.safety_cases_passed,
    gate_passed: recomputed.summary.gate_passed,
    attestation_verified: true,
    source_commit_verified: true,
    built_cli_verified: true,
    verification_scope: 'authenticated_campaign_artifacts',
    live_discord_revalidation: false,
    activity_semantics_verified: recomputed.summary.completed,
  };
}

function benchmarkToken(environment) {
  const value = environment.DISCORD_TOKEN;
  if (typeof value !== 'string' || value.trim() === '')
    throw new Error('DISCORD_TOKEN is required');
  const trimmed = value.trim();
  return trimmed.startsWith('Bot ') ? trimmed.slice(4) : trimmed;
}

export async function main(args = process.argv.slice(2), environment = process.env) {
  const values = new Map();
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (!['--artifact-root', '--run-id', '--expected-commit'].includes(flag)) {
      throw new Error('unknown or positional CLI option');
    }
    if (values.has(flag) || index + 1 >= args.length || args[index + 1].startsWith('--')) {
      throw new Error(`${flag} is required exactly once`);
    }
    values.set(flag, args[index + 1]);
    index += 1;
  }
  if (values.size !== 3)
    throw new Error('exactly --artifact-root, --run-id, and --expected-commit are required');
  const artifactRoot = values.get('--artifact-root');
  const runId = values.get('--run-id');
  const expectedCommit = values.get('--expected-commit');
  return verifyRealBenchmarkArtifact({
    artifactRoot,
    runId,
    expectedCommit,
    integrityKey: benchmarkToken(environment),
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
    // biome-ignore lint/suspicious/noConsole: the verifier's success summary is its CLI contract.
    .then((summary) => console.log(JSON.stringify(summary)))
    .catch(() => {
      console.error(JSON.stringify({ ok: false, code: 'BENCHMARK_ARTIFACT_VERIFICATION_FAILED' }));
      process.exitCode = 1;
    });
}
