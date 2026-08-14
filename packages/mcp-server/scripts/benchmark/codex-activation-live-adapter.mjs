import { createHash } from 'node:crypto';
import { lstat, mkdir } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  acquireCampaignLock,
  readBaselineArtifact,
  writeActivationAttestationArtifact,
} from './artifact-store.mjs';
import {
  BenchmarkRestoreFailure,
  restoreBenchmarkBaseline,
  verifyBenchmarkBaseline,
} from './baseline-lifecycle.mjs';
import { CONTROLLED_BOT_ID, CONTROLLED_GUILD_IDS } from './campaign.mjs';
import { createTrialDependencies } from './runtime.mjs';
import { buildCodexEnvironment, resolveCodexLauncher } from './small-model-eval.mjs';
import {
  buildSmallModelLiveArguments,
  classifySmallModelLiveInitial,
  classifySmallModelLiveResume,
  parseSmallModelLiveJsonl,
  preparePrivateCodexHome,
  runBoundedCodexProcess,
  SMALL_MODEL_LIVE_REQUEST,
} from './small-model-live-eval.mjs';
import { snapshotFingerprint } from './snapshot-fingerprint.mjs';
import {
  activityEvidenceSummary,
  publicationTargets,
  recoverCheckpointBindings,
  validateApply,
  validatePlan,
} from './trial-runner.mjs';

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const PLAN_REF = /^dmbpr1\.[a-f0-9]{64}$/;
const HOST_VERSION = /\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/;
const MAX_RESUME_TURNS = 8;
const HOST_TIMEOUT_MS = 175_000;
const MAX_EXTERNAL_WAIT_MS = 15 * 60_000;
const RESTORE_DELAYS_MS = Object.freeze([0, 250, 500, 1_000, 2_000, 4_000]);
const TERMINAL_APPLY = new Set(['complete', 'already_current']);

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function digest(value) {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function resultData(result) {
  if (!record(result)) return null;
  return result.structured_content ?? result.structuredContent ?? result.data ?? result;
}

function hostFailed(result) {
  return (
    !record(result) ||
    result.spawnError === true ||
    result.timedOut === true ||
    result.aborted === true ||
    result.truncated === true ||
    result.signal !== null ||
    result.exitCode !== 0
  );
}

function assertTarget(value, target, label) {
  const binding = value?.binding ?? value?.target ?? value;
  if (binding?.guildId !== target.guildId || binding?.botId !== target.botId) {
    throw new Error(`${label} target binding mismatch`);
  }
}

function exactCompletedTool(parsed, tool) {
  if (
    !record(parsed) ||
    parsed.contract_errors.length !== 0 ||
    parsed.malformed_json_lines !== 0 ||
    parsed.trace.length !== 1 ||
    parsed.trace[0]?.status !== 'completed' ||
    parsed.trace[0]?.tool !== tool
  ) {
    throw new Error(`Codex ${tool} phase violated the exact tool contract`);
  }
  return parsed.trace[0];
}

function trialFor(target) {
  return {
    trial_id: 'codex-activation',
    mode: 'full',
    guild_id: target.guildId,
    expected_bot_id: target.botId,
    profile: 'caller-owned-devbot',
  };
}

function cleanupFromBindings(
  plan,
  target,
  bindings,
  { requireComplete, resolvePublicationTargets = publicationTargets },
) {
  const targets = resolvePublicationTargets(plan.blueprint, bindings, { requireComplete });
  return {
    guild_id: target.guildId,
    bot_id: target.botId,
    blueprint_id: plan.blueprint_id,
    plan_id: plan.plan_id,
    bindings,
    publication_targets: targets,
    message_channel_ids: [...new Set(targets.map((item) => item.channel_id))].sort(),
  };
}

function exactBaseline(result, baseline) {
  return (
    result?.verified === true &&
    result.guild_id === baseline.guild_id &&
    result.bot_id === baseline.bot_id &&
    result.fingerprint === baseline.fingerprint
  );
}

function assertBaselineTarget(context, target) {
  if (
    !record(context) ||
    context.baseline.guild_id !== target?.guildId ||
    context.baseline.bot_id !== target?.botId
  ) {
    throw new Error('activation baseline target binding mismatch');
  }
}

function abortableWait(milliseconds, signal) {
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0)
    throw new TypeError('wait must be a nonnegative integer');
  if (signal?.aborted === true) throw signal.reason ?? new Error('operation aborted');
  return new Promise((resolveWait, rejectWait) => {
    let timer;
    const onAbort = () => {
      clearTimeout(timer);
      rejectWait(signal.reason ?? new Error('operation aborted'));
    };
    timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolveWait();
    }, milliseconds);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function defaultActivityValidator(corePath, coreDigest) {
  if (typeof corePath !== 'string' || !DIGEST.test(coreDigest ?? ''))
    throw new Error('installed core validator provenance is invalid');
  const module = await import(
    `${pathToFileURL(corePath).href}?codex_activation=${coreDigest.slice('sha256:'.length)}`
  );
  if (typeof module.assertGuildBlueprintActivityEvidence !== 'function')
    throw new Error('installed core Activity Evidence validator is unavailable');
  return module.assertGuildBlueprintActivityEvidence;
}

async function removePrivateHome(privateHome) {
  await privateHome.cleanup();
  try {
    await lstat(privateHome.path);
    return false;
  } catch (error) {
    if (error?.code === 'ENOENT') return true;
    throw error;
  }
}

/**
 * Audited real-host seams for one Codex activation trial. The returned object
 * is stateful only for private baseline/lock context and registered sessions.
 */
export function createCodexActivationLiveAdapter({
  environment = process.env,
  cwd = process.cwd(),
  platform = process.platform,
  verifyRuntimePackage,
  resolveLauncher = resolveCodexLauncher,
  runProcess = runBoundedCodexProcess,
  prepareCodexHome = preparePrivateCodexHome,
  loadActivityValidator = defaultActivityValidator,
  createRuntime = createTrialDependencies,
  readBaseline = readBaselineArtifact,
  verifyBaselineRecord = verifyBenchmarkBaseline,
  restoreBaselineRecord = restoreBenchmarkBaseline,
  acquireLock = acquireCampaignLock,
  writeAttestation = writeActivationAttestationArtifact,
  validatePlanResult = validatePlan,
  validateApplyResult = validateApply,
  summarizeActivityEvidence = activityEvidenceSummary,
  resolvePublicationTargets = publicationTargets,
  recoverBindings = recoverCheckpointBindings,
  now = () => new Date().toISOString(),
} = {}) {
  if (!record(environment)) throw new TypeError('environment is required');
  if (typeof cwd !== 'string' || cwd.trim() === '') throw new TypeError('cwd is required');
  for (const [name, seam] of Object.entries({
    verifyRuntimePackage,
    resolveLauncher,
    runProcess,
    prepareCodexHome,
    loadActivityValidator,
    createRuntime,
    readBaseline,
    verifyBaselineRecord,
    restoreBaselineRecord,
    acquireLock,
    writeAttestation,
    validatePlanResult,
    validateApplyResult,
    summarizeActivityEvidence,
    resolvePublicationTargets,
    recoverBindings,
    now,
  })) {
    if (typeof seam !== 'function') throw new TypeError(`${name} must be a function`);
  }

  const baselineContexts = new WeakMap();

  const artifactRoot = () => {
    const value = environment.DISCORD_MCP_ACTIVATION_ARTIFACT_ROOT;
    if (typeof value !== 'string' || !isAbsolute(value))
      throw new Error('DISCORD_MCP_ACTIVATION_ARTIFACT_ROOT must be absolute');
    return value;
  };

  const runHost = async (session, args, signal) => {
    if (session.active) throw new Error('Codex session already has an active host process');
    session.active = true;
    try {
      const result = await runProcess({
        launcher: session.launcher,
        args,
        cwd: session.cwd,
        env: session.childEnvironment,
        timeoutMs: HOST_TIMEOUT_MS,
        platform,
        signal,
      });
      if (hostFailed(result)) throw new Error('Codex host process failed');
      return result;
    } catch (error) {
      if (error?.code === 'CODEX_PROCESS_DID_NOT_CLOSE') session.unsettled = true;
      throw error;
    } finally {
      session.active = false;
    }
  };

  const cacheApplyCleanup = (session, rawApply) => {
    const data = resultData(rawApply);
    if (!record(data)) throw new Error('Codex apply result is missing');
    validateApplyResult(data, session.plan, session.trial);
    session.lastApply = data;
    session.cleanup = cleanupFromBindings(session.plan, session.target, data.evidence.bindings, {
      requireComplete: TERMINAL_APPLY.has(data.status),
      resolvePublicationTargets,
    });
    return data;
  };

  const restoreWithRecovery = async ({ context, cleanup, signal }) => {
    let retryProof = null;
    let lastFailure = null;
    for (const delayMs of RESTORE_DELAYS_MS) {
      if (delayMs > 0) await abortableWait(delayMs, signal);
      let restoreCompleted = false;
      try {
        const restored = await restoreBaselineRecord({
          rest: context.runtime.rest,
          readSnapshot: context.runtime.readSnapshot,
          snapshotFingerprint,
          baseline: context.baseline,
          allowedGuildIds: CONTROLLED_GUILD_IDS,
          expectedBotId: CONTROLLED_BOT_ID,
          confirmation: `RESET_DISPOSABLE_GUILD:${context.baseline.guild_id}`,
          cleanup,
          reason: 'discord-mcp Codex activation restore',
          retryProof,
          integrityKey: context.token,
        });
        if (restored?.restored !== true) throw new Error('baseline restore was not confirmed');
        retryProof = restored.retryProof ?? retryProof;
        restoreCompleted = true;
        const verified = await verifyBaselineRecord({
          readSnapshot: context.runtime.readSnapshot,
          snapshotFingerprint,
          baseline: context.baseline,
          integrityKey: context.token,
        });
        if (!exactBaseline(verified, context.baseline))
          throw new Error('baseline restore verification was not exact');
        return verified;
      } catch (error) {
        lastFailure = error;
        if (error instanceof BenchmarkRestoreFailure) {
          if (error.preflightVerified && error.retryProof !== null) retryProof = error.retryProof;
          if (error.readbackMayConfirm) {
            try {
              const verified = await verifyBaselineRecord({
                readSnapshot: context.runtime.readSnapshot,
                snapshotFingerprint,
                baseline: context.baseline,
                integrityKey: context.token,
              });
              if (exactBaseline(verified, context.baseline)) return verified;
            } catch {
              // Continue only under the typed retry policy below.
            }
          }
          if (error.retryable) continue;
        }
        if (restoreCompleted && retryProof !== null) continue;
        throw error;
      }
    }
    throw lastFailure ?? new Error('baseline restore failed');
  };

  return {
    async launch({
      release,
      hostVersion,
      target,
      installRoot,
      install,
      stateDirectory,
      env,
      binding,
      registerSession,
      signal,
    }) {
      assertTarget(binding, target, 'guided setup');
      if (typeof registerSession !== 'function') throw new TypeError('registerSession is required');
      if (!isAbsolute(stateDirectory)) throw new TypeError('stateDirectory must be absolute');
      if (
        !record(install) ||
        !DIGEST.test(install.cliDigest ?? '') ||
        !DIGEST.test(install.coreDigest ?? '')
      ) {
        throw new Error('installed runtime provenance is unavailable');
      }
      await mkdir(stateDirectory, { recursive: true });
      const runtimePackage = await verifyRuntimePackage({ installRoot, install });
      if (
        !record(runtimePackage) ||
        typeof runtimePackage.cliPath !== 'string' ||
        typeof runtimePackage.corePath !== 'string'
      ) {
        throw new Error('runtime package verification failed');
      }
      const baseChildEnvironment = buildCodexEnvironment(environment, {
        token: env?.DISCORD_TOKEN,
      });
      const privateHome = await prepareCodexHome({ env: environment, stateDirectory });
      const childEnvironment = {
        ...baseChildEnvironment,
        CODEX_HOME: privateHome.path,
      };
      const session = {
        active: false,
        unsettled: false,
        closed: false,
        isolated: true,
        clientReady: false,
        firstRequest: false,
        sessionDigest: null,
        binding: { guildId: target.guildId, botId: target.botId },
        target: { guildId: target.guildId, botId: target.botId },
        cwd: installRoot,
        stateDirectory,
        cliPath: runtimePackage.cliPath,
        corePath: runtimePackage.corePath,
        coreDigest: install.coreDigest,
        childEnvironment,
        privateHome,
        launcher: null,
        threadId: null,
        plan: null,
        trial: trialFor(target),
        trace: [],
        lastApply: null,
        evidence: null,
        cleanup: null,
        validator: null,
      };
      try {
        registerSession(session);
      } catch (error) {
        await removePrivateHome(privateHome);
        throw error;
      }
      session.launcher = await resolveLauncher({ platform });
      session.validator = await loadActivityValidator(session.corePath, session.coreDigest);

      const versionResult = await runHost(session, ['--version'], signal);
      const actualVersion = HOST_VERSION.exec(versionResult.stdout)?.[1] ?? null;
      if (actualVersion !== hostVersion) throw new Error('Codex host version mismatch');

      const initialResult = await runHost(
        session,
        buildSmallModelLiveArguments({
          phase: 'initial',
          cliPath: session.cliPath,
          cwd: session.cwd,
          target,
          stateDirectory,
          request: SMALL_MODEL_LIVE_REQUEST,
        }),
        signal,
      );
      const parsed = parseSmallModelLiveJsonl(initialResult.stdout, { includeRaw: true });
      if (
        classifySmallModelLiveInitial({
          parsed,
          target,
          request: SMALL_MODEL_LIVE_REQUEST,
          ...initialResult,
        }) !== 'pass'
      ) {
        throw new Error('Codex initial preview contract failed');
      }
      const call = exactCompletedTool(parsed, 'build_discord_server');
      const plan = resultData(call.__raw?.result);
      validatePlanResult(plan, session.trial);
      if (!PLAN_REF.test(plan.plan_ref ?? '')) throw new Error('Codex plan_ref is invalid');
      session.threadId = parsed.thread_id;
      session.plan = plan;
      session.trace = [...parsed.trace];
      session.clientReady = true;
      session.firstRequest = true;
      session.sessionDigest = digest({
        schema_version: 'discord-mcp.codex-activation-session.v1',
        release,
        host_version: actualVersion,
        guild_id: target.guildId,
        bot_id: target.botId,
        thread_id: session.threadId,
        plan_id: plan.plan_id,
        blueprint_id: plan.blueprint_id,
        cli_digest: install.cliDigest,
        core_digest: install.coreDigest,
      });
      return session;
    },

    async apply({ session, target, binding, signal }) {
      if (!record(session) || session.closed || session.unsettled || !record(session.plan))
        throw new Error('Codex activation session is unavailable');
      assertTarget(session, target, 'session');
      assertTarget(binding, target, 'apply');
      const continuation = {
        plan_id: session.plan.plan_id,
        blueprint_id: session.plan.blueprint_id,
        approval_id: session.plan.approval_id,
        plan_ref: session.plan.plan_ref,
      };
      let externalWaitMs = 0;
      for (let turn = 0; turn < MAX_RESUME_TURNS; turn += 1) {
        const result = await runHost(
          session,
          buildSmallModelLiveArguments({
            phase: 'resume',
            resumeMode: 'apply',
            cliPath: session.cliPath,
            cwd: session.cwd,
            target,
            stateDirectory: session.stateDirectory,
            sessionId: session.threadId,
            binding: continuation,
          }),
          signal,
        );
        const parsed = parseSmallModelLiveJsonl(result.stdout, { includeRaw: true });
        const call = exactCompletedTool(parsed, 'guild_blueprint_apply');
        const apply = cacheApplyCleanup(session, call.__raw?.result);
        const classification = classifySmallModelLiveResume({
          parsed,
          sessionId: session.threadId,
          target,
          binding: continuation,
          trace: session.trace,
        });
        session.trace.push(...parsed.trace);
        if (classification !== 'resume_required')
          throw new Error(`Codex apply contract failed: ${classification}`);
        if (TERMINAL_APPLY.has(apply.status)) {
          return {
            ...apply,
            binding: { guildId: target.guildId, botId: target.botId },
          };
        }
        const retryAfterMs = apply.error?.retry_after_ms ?? 0;
        if (!Number.isSafeInteger(retryAfterMs) || retryAfterMs < 0)
          throw new Error('Codex apply retry delay is invalid');
        if (externalWaitMs + retryAfterMs > MAX_EXTERNAL_WAIT_MS)
          throw new Error('Codex apply external wait limit exceeded');
        await abortableWait(retryAfterMs, signal);
        externalWaitMs += retryAfterMs;
      }
      throw new Error('Codex apply resume turn limit exceeded');
    },

    async evidence({ session, target, apply, binding, signal }) {
      if (
        !record(session) ||
        session.closed ||
        session.unsettled ||
        !TERMINAL_APPLY.has(apply?.status) ||
        !TERMINAL_APPLY.has(session.lastApply?.status)
      ) {
        throw new Error('Codex activation apply is not complete');
      }
      assertTarget(session, target, 'session');
      assertTarget(binding, target, 'evidence');
      const continuation = {
        plan_id: session.plan.plan_id,
        blueprint_id: session.plan.blueprint_id,
        approval_id: session.plan.approval_id,
        plan_ref: session.plan.plan_ref,
      };
      const result = await runHost(
        session,
        buildSmallModelLiveArguments({
          phase: 'resume',
          resumeMode: 'evidence',
          cliPath: session.cliPath,
          cwd: session.cwd,
          target,
          stateDirectory: session.stateDirectory,
          sessionId: session.threadId,
          binding: continuation,
        }),
        signal,
      );
      const parsed = parseSmallModelLiveJsonl(result.stdout, { includeRaw: true });
      const call = exactCompletedTool(parsed, 'guild_blueprint_evidence');
      const classification = classifySmallModelLiveResume({
        parsed,
        sessionId: session.threadId,
        target,
        binding: continuation,
        trace: session.trace,
      });
      if (classification !== 'pass')
        throw new Error(`Codex evidence contract failed: ${classification}`);
      const rawEvidence = resultData(call.__raw?.result);
      const summary = summarizeActivityEvidence(rawEvidence, session.plan, session.trial);
      const activityEvidence = {
        ...summary.evidence_body,
        evidence_id: summary.evidence_id,
      };
      session.validator(activityEvidence);
      session.trace.push(...parsed.trace);
      session.evidence = rawEvidence;
      return {
        binding: { guildId: target.guildId, botId: target.botId },
        status: 'verified',
        activityEvidence,
      };
    },

    async closeSession({ session }) {
      if (!record(session)) return { settled: false };
      if (session.closed) return { settled: true, closed: true };
      if (session.active) return { settled: false };
      const removed = await removePrivateHome(session.privateHome);
      session.closed = removed;
      if (session.unsettled) return { settled: false, authRemoved: removed };
      return { settled: removed, closed: removed };
    },

    async captureBaseline({ target, token, runId, sourceCommit }) {
      if (!CONTROLLED_GUILD_IDS.includes(target.guildId) || target.botId !== CONTROLLED_BOT_ID)
        throw new Error('activation target is outside the controlled pool');
      const baseline = await readBaseline({
        cwd,
        artifactRoot: artifactRoot(),
        guildId: target.guildId,
        integrityKey: token,
      });
      if (baseline.bot_id !== target.botId) throw new Error('activation baseline bot mismatch');
      const lock = await acquireLock({
        botId: CONTROLLED_BOT_ID,
        guildIds: CONTROLLED_GUILD_IDS,
        owner: { run_id: runId, commit: sourceCommit, started_at: now() },
      });
      const runtime = createRuntime({ token });
      try {
        const verified = await verifyBaselineRecord({
          readSnapshot: runtime.readSnapshot,
          snapshotFingerprint,
          baseline,
          integrityKey: token,
        });
        if (!exactBaseline(verified, baseline))
          throw new Error('activation baseline verification is not exact');
        const capture = { beforeDigest: verified.fingerprint };
        baselineContexts.set(capture, { baseline, lock, runtime, token, released: false });
        return capture;
      } catch (error) {
        await lock.release();
        throw error;
      }
    },

    async restoreBaseline({ target, baseline: capture, session, signal }) {
      const context = baselineContexts.get(capture);
      if (!context) throw new Error('activation baseline context is unavailable');
      assertBaselineTarget(context, target);
      try {
        const verified = await verifyBaselineRecord({
          readSnapshot: context.runtime.readSnapshot,
          snapshotFingerprint,
          baseline: context.baseline,
          integrityKey: context.token,
        });
        if (exactBaseline(verified, context.baseline)) return { restored: true };
      } catch {
        // A typed restore performs its own authoritative preflight below.
      }
      let cleanup = session?.cleanup ?? null;
      if (cleanup === null && record(session?.plan)) {
        const checkpoint = await context.runtime.loadCheckpoint({
          stateDirectory: session.stateDirectory,
          planId: session.plan.plan_id,
        });
        if (checkpoint !== null) {
          const bindings = recoverBindings(checkpoint, session.plan, session.trial, null, -1);
          cleanup = cleanupFromBindings(session.plan, target, bindings, {
            requireComplete: false,
            resolvePublicationTargets,
          });
        }
      }
      if (cleanup === null) throw new Error('activation cleanup bindings are unavailable');
      await restoreWithRecovery({ context, cleanup, signal });
      return { restored: true };
    },

    async verifyBaseline({ target, baseline: capture }) {
      const context = baselineContexts.get(capture);
      if (!context) throw new Error('activation baseline context is unavailable');
      assertBaselineTarget(context, target);
      const verified = await verifyBaselineRecord({
        readSnapshot: context.runtime.readSnapshot,
        snapshotFingerprint,
        baseline: context.baseline,
        integrityKey: context.token,
      });
      if (!exactBaseline(verified, context.baseline))
        throw new Error('activation baseline verification is not exact');
      if (!context.released) {
        await context.lock.release();
        context.released = true;
      }
      return {
        exact: true,
        restored: true,
        afterDigest: verified.fingerprint,
      };
    },

    async validateActivityEvidence(activityEvidence, { session } = {}) {
      if (typeof session?.validator !== 'function')
        throw new Error('installed Activity Evidence validator is unavailable');
      session.validator(activityEvidence);
      return true;
    },

    async persistAttestation({ runId, trialId, attestation, digest: envelopeDigest }) {
      return writeAttestation({
        cwd,
        artifactRoot: artifactRoot(),
        runId,
        trialId,
        digest: envelopeDigest,
        attestation,
      });
    },
  };
}
