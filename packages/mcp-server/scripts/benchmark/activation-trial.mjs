import { createHash } from 'node:crypto';

import { activationTrialDigest, createActivationTrialArtifact } from './activation-artifact.mjs';
import {
  canonicalActivationAttestationDigest,
  canonicalActivationEvidenceDigest,
  createActivationAttestation,
  verifyActivationAttestation,
} from './activation-attestation.mjs';

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const ADAPTER_ID = /^[a-z][a-z0-9._-]{2,63}$/;
const APPLY_SUCCESS = new Set(['complete', 'already_current']);
const EXECUTION_PROVENANCE_KEYS = ['abortable', 'adapter_id', 'execution_mode', 'package_source'];
const ACTIVATION_PHASES = Object.freeze([
  'install',
  'setup',
  'client_ready',
  'first_request',
  'apply',
  'evidence',
  'restore',
  'total',
]);
const DEFAULT_LIMITS = Object.freeze({
  phaseTimeoutMs: 180_000,
  recoveryTimeoutMs: 30_000,
  cancellationTimeoutMs: 5_000,
});

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertExecutionProvenance(value, executionMode) {
  if (!record(value)) throw new TypeError('dependency executionProvenance is required');
  const keys = Object.keys(value).sort();
  if (
    keys.length !== EXECUTION_PROVENANCE_KEYS.length ||
    keys.some((key, index) => key !== EXECUTION_PROVENANCE_KEYS[index])
  )
    throw new TypeError('dependency executionProvenance has invalid keys');
  if (value.execution_mode !== executionMode)
    throw new TypeError('dependency execution mode does not match the request');
  if (typeof value.adapter_id !== 'string' || !ADAPTER_ID.test(value.adapter_id))
    throw new TypeError('dependency adapter id is invalid');
  if (value.abortable !== true) throw new TypeError('dependency adapter must support cancellation');
  const expectedPackageSource =
    executionMode === 'live' ? 'verified_npm_provenance' : 'test_fixture';
  if (value.package_source !== expectedPackageSource)
    throw new TypeError('dependency package source does not match the execution mode');
  return { ...value };
}

function digest(value) {
  const input = typeof value === 'string' ? value : JSON.stringify(value ?? null);
  return `sha256:${createHash('sha256').update(input).digest('hex')}`;
}

function bindingMatches(value, target) {
  const binding = value?.binding ?? value?.target ?? value;
  return binding?.guildId === target.guildId && binding?.botId === target.botId;
}

function hasReportedBinding(value) {
  if (!record(value)) return false;
  const binding = value.binding ?? value.target ?? value;
  return record(binding) && ('guildId' in binding || 'botId' in binding);
}

function lifecycleCloseSettled(value) {
  return (
    record(value) && (value.settled === true || value.closed === true || value.terminated === true)
  );
}

function readinessOf(value) {
  if (value === true || value === 'ready') return 'ready';
  if (value === 'blocked') return 'blocked';
  return 'failed';
}

function evidenceOf(value) {
  if (value === 'verified' || value?.status === 'verified') return 'verified';
  if (value === 'blocked' || value?.status === 'blocked') return 'blocked';
  return 'failed';
}

function applyOf(value) {
  const status = value?.status ?? value;
  if (APPLY_SUCCESS.has(status)) return 'completed';
  if (status === 'blocked') return 'blocked';
  return 'failed';
}

function safeClock(clock) {
  const now = clock?.now ?? (() => performance.now());
  if (typeof now !== 'function') throw new TypeError('clock.now must be a function');
  let previous = Number.NEGATIVE_INFINITY;
  return () => {
    const value = Number(now());
    if (!Number.isFinite(value) || value < previous) throw new Error('clock is not monotonic');
    previous = value;
    return value;
  };
}

class PhaseTimeoutError extends Error {
  constructor(name) {
    super(`${name} phase timed out`);
    this.name = 'PhaseTimeoutError';
  }
}

/**
 * Run one clean activation trial for a caller-owned host adapter. Host
 * process/configuration details stay behind dependencies; this runner owns
 * the safety lifecycle, Activity Evidence validation, and attestation.
 */
export async function runActivationTrial({
  request,
  dependencies,
  clock,
  host,
  limits = DEFAULT_LIMITS,
  assertConfigReady,
  assertConfigWritable,
  buildLaunchEnvironment,
  resolveProfileEnvironmentKey = (workspaceState) => workspaceState.profileEnvironmentKey,
  isTrustedLiveDependencies = () => false,
} = {}) {
  if (!record(request)) throw new TypeError('activation request is required');
  if (!record(dependencies)) throw new TypeError('activation dependencies are required');
  if (typeof host !== 'string' || !/^[a-z][a-z0-9._-]{1,31}$/.test(host))
    throw new TypeError('activation host is invalid');
  if (typeof assertConfigReady !== 'function') throw new TypeError('assertConfigReady is required');
  if (typeof assertConfigWritable !== 'function')
    throw new TypeError('assertConfigWritable is required');
  if (typeof buildLaunchEnvironment !== 'function')
    throw new TypeError('buildLaunchEnvironment is required');
  if (typeof resolveProfileEnvironmentKey !== 'function')
    throw new TypeError('resolveProfileEnvironmentKey is required');
  if (typeof isTrustedLiveDependencies !== 'function')
    throw new TypeError('isTrustedLiveDependencies must be a function');
  if (
    !record(limits) ||
    !Number.isSafeInteger(limits.phaseTimeoutMs) ||
    limits.phaseTimeoutMs <= 0 ||
    limits.phaseTimeoutMs > DEFAULT_LIMITS.phaseTimeoutMs ||
    !Number.isSafeInteger(limits.recoveryTimeoutMs) ||
    limits.recoveryTimeoutMs <= 0 ||
    limits.recoveryTimeoutMs > DEFAULT_LIMITS.recoveryTimeoutMs ||
    !Number.isSafeInteger(limits.cancellationTimeoutMs) ||
    limits.cancellationTimeoutMs <= 0 ||
    limits.cancellationTimeoutMs > DEFAULT_LIMITS.cancellationTimeoutMs
  )
    throw new TypeError('activation limits are invalid');

  const required = [
    'install',
    'setup',
    'enableWrites',
    'launch',
    'apply',
    'evidence',
    'captureBaseline',
    'restoreBaseline',
    'verifyBaseline',
  ];
  for (const name of required) {
    if (typeof dependencies[name] !== 'function')
      throw new TypeError(`dependency ${name} is required`);
  }
  const workspace = dependencies.workspace;
  if (!record(workspace)) throw new TypeError('workspace is required');
  for (const name of ['create', 'readText', 'writeText', 'remove']) {
    if (typeof workspace[name] !== 'function') throw new TypeError(`workspace.${name} is required`);
  }
  const closeSession = dependencies.closeSession ?? dependencies.terminate;
  if (request.executionMode === 'live' && typeof closeSession !== 'function')
    throw new TypeError('live execution requires closeSession or terminate lifecycle seam');
  const executionProvenance = assertExecutionProvenance(
    dependencies.executionProvenance,
    request.executionMode,
  );
  if (request.executionMode === 'live' && !isTrustedLiveDependencies(dependencies))
    throw new TypeError('live execution requires the built-in audited dependency adapter');
  const now = safeClock(clock);
  const started = now();
  const durations = Object.fromEntries(ACTIVATION_PHASES.map((phase) => [phase, 0]));
  const readiness = {
    install: 'blocked',
    setup: 'blocked',
    client: 'blocked',
    first_request: 'blocked',
  };
  const evidence = { apply: 'blocked', guild_blueprint_evidence: 'blocked' };
  let dangerousPermissions = false;
  let bindingVerified = false;
  const callerOwnedBot = request.target.callerOwned === true;
  let cleanProfile = false;
  let cleanupVerified = false;
  let isolatedSession = false;
  let failure = false;
  let timedOut = false;
  let unsettledOperation = false;
  let baseline = null;
  let baselineCaptured = false;
  let workspaceState = null;
  let installResult = null;
  let session = null;
  let activityEvidence = null;
  let activityEvidenceValidated = false;
  let configDigest = digest('config-unavailable');
  let buildDigests = null;
  let beforeDigest = digest('baseline-unavailable-before');
  let afterDigest = digest('baseline-unavailable-after');
  let buildDigest = digest(`@discord-mcp/cli@${request.release}`);
  let evidenceDigest = digest('evidence-unavailable');
  let sessionDigest = digest('session-unavailable');
  let launchInvoked = false;
  let sessionRegistered = false;

  const registerSession = (handle) => {
    if (!record(handle)) throw new TypeError('launch session handle must be an object');
    if (session !== null && session !== handle)
      throw new Error('launch attempted to replace its registered session handle');
    session = handle;
    sessionRegistered = true;
    return handle;
  };
  let sessionClosed = false;

  const markTotal = () => {
    const elapsed = now() - started;
    durations.total = elapsed;
    if (!Number.isSafeInteger(Math.round(elapsed)) || elapsed < 0) failure = true;
    if (elapsed >= request.maxDurationMs) {
      failure = true;
      timedOut = true;
    }
    durations.total = Math.max(0, Math.round(elapsed));
  };

  const waitForCancellation = async (operation) => {
    let timer;
    try {
      return await Promise.race([
        operation.then(
          () => true,
          () => true,
        ),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(false), limits.cancellationTimeoutMs);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };

  const phase = async (name, fn, { recovery = false } = {}) => {
    if (failure && name !== 'restore') return null;
    const begin = now();
    const controller = new AbortController();
    const remaining = request.maxDurationMs - (begin - started);
    const timeoutMs = recovery
      ? limits.recoveryTimeoutMs
      : Math.max(1, Math.min(limits.phaseTimeoutMs, remaining));
    let timer;
    let operation;
    let timeoutTriggered = false;
    try {
      operation = Promise.resolve().then(() => fn({ signal: controller.signal }));
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
          timeoutTriggered = true;
          controller.abort();
          reject(new PhaseTimeoutError(name));
        }, timeoutMs);
      });
      const value = await Promise.race([operation, timeout]);
      const elapsed = now() - begin;
      if (elapsed < 0 || elapsed >= request.maxDurationMs) {
        failure = true;
        timedOut = true;
      }
      durations[name] = Math.max(0, Math.round(elapsed));
      return value;
    } catch (error) {
      failure = true;
      if (error?.administratorWarning === true) dangerousPermissions = true;
      if (timeoutTriggered || error instanceof PhaseTimeoutError) {
        timedOut = true;
        controller.abort();
        if (operation && !(await waitForCancellation(operation))) unsettledOperation = true;
      }
      durations[name] = Math.max(0, Math.round(now() - begin));
      return null;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };

  const boundedCall = async (name, fn, { recovery = false } = {}) => {
    const begin = now();
    const controller = new AbortController();
    const remaining = request.maxDurationMs - (begin - started);
    const timeoutMs = recovery
      ? limits.recoveryTimeoutMs
      : Math.max(1, Math.min(limits.phaseTimeoutMs, remaining));
    let timer;
    let operation;
    let timeoutTriggered = false;
    try {
      operation = Promise.resolve().then(() => fn({ signal: controller.signal }));
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
          timeoutTriggered = true;
          controller.abort();
          reject(new PhaseTimeoutError(name));
        }, timeoutMs);
      });
      return await Promise.race([operation, timeout]);
    } catch (error) {
      failure = true;
      if (timeoutTriggered || error instanceof PhaseTimeoutError) {
        timedOut = true;
        controller.abort();
        if (operation && !(await waitForCancellation(operation))) unsettledOperation = true;
      }
      return null;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };

  try {
    workspaceState = await boundedCall('workspace.create', ({ signal }) =>
      workspace.create({ trialId: request.trialId, signal }),
    );
    baseline = await boundedCall('captureBaseline', ({ signal }) =>
      dependencies.captureBaseline({
        target: request.target,
        token: request.token,
        runId: request.runId,
        trialId: request.trialId,
        sourceCommit: request.sourceCommit,
        signal,
      }),
    );
    const capturedDigest = baseline?.beforeDigest ?? baseline?.digest;
    if (!record(baseline) || !DIGEST.test(capturedDigest ?? '')) {
      baseline = null;
      failure = true;
    } else {
      baselineCaptured = true;
      beforeDigest = capturedDigest;
    }

    installResult = await phase('install', async ({ signal }) => {
      const result = await dependencies.install({
        release: request.release,
        sourceCommit: request.sourceCommit,
        installRoot: workspaceState.installRoot,
        target: request.target,
        signal,
      });
      if (result?.sourceCommit !== request.sourceCommit)
        throw new Error('installed package source commit mismatch');
      if (result?.hostVersion !== undefined && result.hostVersion !== request.hostVersion)
        throw new Error(`${host} host version mismatch`);
      return result;
    });
    readiness.install = installResult ? 'ready' : 'failed';
    if (installResult) {
      buildDigests = {
        cli_digest: installResult.cliDigest,
        core_digest: installResult.coreDigest,
        package_digest: installResult.packageDigest,
      };
      if (
        !DIGEST.test(buildDigests.cli_digest ?? '') ||
        !DIGEST.test(buildDigests.core_digest ?? '') ||
        !DIGEST.test(buildDigests.package_digest ?? '')
      ) {
        failure = true;
      } else {
        buildDigest = buildDigests.package_digest;
      }
    }
    cleanProfile = workspaceState?.cleanProfile === true;
    const resolvedProfileEnvironmentKey = resolveProfileEnvironmentKey(workspaceState);

    const profile = `activation-${request.trialId}`;
    const setup = await phase('setup', async ({ signal }) => {
      const result = await dependencies.setup({
        release: request.release,
        profile,
        target: request.target,
        configPath: workspaceState.configPath,
        profileRoot: workspaceState.profileRoot,
        profileEnvironmentKey: resolvedProfileEnvironmentKey,
        home: workspaceState.home,
        installRoot: workspaceState.installRoot,
        token: request.token,
        signal,
      });
      if (result?.administratorWarning === true) dangerousPermissions = true;
      if ((result?.exitCode ?? 0) !== 0 || result?.administratorWarning === true)
        throw new Error('guided setup failed safety checks');
      if (result?.bindingVerified !== true || !bindingMatches(result?.binding, request.target))
        throw new Error('guided setup binding proof is missing or mismatched');
      bindingVerified = true;
      const config = result?.config ?? (await workspace.readText(workspaceState.configPath));
      assertConfigReady(config, {
        release: request.release,
        token: request.token,
        trialId: request.trialId,
        profile,
        target: request.target,
      });
      return { ...result, config };
    });
    readiness.setup = setup ? 'ready' : 'failed';

    if (setup && request.writeApproval !== undefined) {
      const client = await phase('client_ready', async ({ signal }) => {
        const result = await dependencies.enableWrites({
          configPath: workspaceState.configPath,
          config: setup.config,
          approval: request.writeApproval,
          request,
          workspaceState,
          install: installResult,
          setup,
          signal,
        });
        const config = result?.config ?? (await workspace.readText(workspaceState.configPath));
        assertConfigWritable(config, {
          request,
          workspaceState,
          install: installResult,
          setup,
        });
        configDigest = digest(config);
        launchInvoked = true;
        const launched = await dependencies.launch({
          release: request.release,
          target: request.target,
          home: workspaceState.home,
          configPath: workspaceState.configPath,
          profileRoot: workspaceState.profileRoot,
          profileEnvironmentKey: resolvedProfileEnvironmentKey,
          installRoot: workspaceState.installRoot,
          install: installResult,
          setup,
          hostVersion: request.hostVersion,
          stateDirectory: workspaceState.stateDirectory,
          env: buildLaunchEnvironment({ workspaceState, request }),
          binding: setup.binding,
          // A live adapter must call this before it starts a process/client so
          // rejection or timeout can never hide a running session from cleanup.
          registerSession,
          signal,
        });
        if (request.executionMode === 'live' && !sessionRegistered)
          throw new Error('live launch did not register its session before returning');
        if (!sessionRegistered) registerSession(launched);
        else if (launched !== undefined && launched !== session)
          throw new Error('launch returned a different session than it registered');
        return { enabled: { ...result, config }, launched: session };
      });
      if (!client && launchInvoked && session === null) unsettledOperation = true;
      if (client) {
        const launched = client.launched;
        session = launched;
        isolatedSession = launched?.isolated === true;
        readiness.client = readinessOf(launched?.clientReady ?? launched?.ready);
        if (!DIGEST.test(launched?.sessionDigest ?? '')) {
          failure = true;
          readiness.client = 'failed';
        } else {
          sessionDigest = launched.sessionDigest;
        }
        const first = await phase('first_request', async ({ signal }) => {
          if (!launched || readiness.client !== 'ready')
            throw new Error(`${host} client is not ready`);
          if (launched.firstRequest !== true && launched.firstRequestStatus !== 'ready')
            throw new Error(`${host} first request did not complete`);
          if (hasReportedBinding(launched) && !bindingMatches(launched, request.target))
            throw new Error('launch target binding mismatch');
          if (signal.aborted) throw new PhaseTimeoutError('first_request');
          return launched;
        });
        readiness.first_request = first ? 'ready' : 'failed';
        const applied = await phase('apply', async ({ signal }) => {
          if (!first) throw new Error('first request failed');
          const result = await dependencies.apply({
            session,
            target: request.target,
            binding: setup.binding,
            signal,
          });
          if (hasReportedBinding(result) && !bindingMatches(result, request.target))
            throw new Error('apply result binding is invalid');
          if (!APPLY_SUCCESS.has(result?.status))
            throw new Error('apply result binding or status is invalid');
          return result;
        });
        evidence.apply = applyOf(applied?.status);
        const verified = await phase('evidence', async ({ signal }) => {
          if (!applied) throw new Error('apply was not complete');
          const result = await dependencies.evidence({
            session,
            target: request.target,
            apply: applied,
            binding: setup.binding,
            signal,
          });
          if (!bindingMatches(result, request.target) || evidenceOf(result) !== 'verified')
            throw new Error('separate guild blueprint evidence is not verified');
          activityEvidence = result?.activityEvidence ?? result?.activity_evidence;
          if (!activityEvidence || typeof activityEvidence !== 'object')
            throw new Error('full Activity Evidence record is required');
          if (
            activityEvidence.target?.guild_id !== request.target.guildId ||
            activityEvidence.target?.bot_id !== request.target.botId
          )
            throw new Error('Activity Evidence target binding mismatch');
          if (typeof dependencies.validateActivityEvidence !== 'function')
            throw new Error('Activity Evidence validator is required');
          const valid = await dependencies.validateActivityEvidence(activityEvidence, {
            session,
            signal,
          });
          if (valid === false) throw new Error('Activity Evidence validation failed');
          activityEvidenceValidated = true;
          return result;
        });
        evidence.guild_blueprint_evidence = evidenceOf(verified);
        evidenceDigest = activityEvidence?.evidence_id ?? digest('evidence-unavailable');
        if (!DIGEST.test(evidenceDigest)) throw new Error('Activity Evidence digest is invalid');
      }
    } else {
      failure = true;
      readiness.client = 'blocked';
      readiness.first_request = 'blocked';
    }
  } catch {
    failure = true;
  } finally {
    if (session !== null && session !== undefined) {
      if (typeof closeSession !== 'function') {
        failure = true;
        unsettledOperation = true;
      } else {
        const closed = await boundedCall(
          'closeSession',
          ({ signal }) => closeSession({ session, target: request.target, signal }),
          { recovery: true },
        );
        sessionClosed = lifecycleCloseSettled(closed);
        if (!sessionClosed) {
          failure = true;
          unsettledOperation = true;
        }
      }
    }
    if (baselineCaptured && !unsettledOperation)
      await phase(
        'restore',
        async ({ signal }) => {
          const restored = await dependencies.restoreBaseline({
            target: request.target,
            baseline,
            session,
            signal,
          });
          const verification = await dependencies.verifyBaseline({
            target: request.target,
            baseline,
            restored,
            signal,
          });
          if (
            verification?.exact !== true ||
            verification?.restored !== true ||
            !DIGEST.test(verification.afterDigest ?? '')
          ) {
            throw new Error('baseline restore was not exact');
          }
          afterDigest = verification.afterDigest;
          if (afterDigest !== beforeDigest)
            throw new Error('baseline exact restore digest mismatch');
          return verification;
        },
        { recovery: true },
      );
    if (workspaceState && !unsettledOperation) {
      try {
        const removed = await boundedCall(
          'workspace.remove',
          ({ signal }) => workspace.remove(workspaceState.root, { signal }),
          { recovery: true },
        );
        cleanupVerified = removed?.removed === true && removed?.verified === true;
        if (!cleanupVerified) failure = true;
      } catch {
        cleanupVerified = false;
        failure = true;
      }
    }
    try {
      markTotal();
    } catch {
      failure = true;
      durations.total = Math.max(0, durations.total);
    }
  }

  const baselineRestored = afterDigest === beforeDigest;
  let privateEnvelopeDigest = digest('private-attestation-unavailable');
  const candidatePass =
    !failure &&
    !timedOut &&
    readiness.install === 'ready' &&
    readiness.setup === 'ready' &&
    readiness.client === 'ready' &&
    readiness.first_request === 'ready' &&
    evidence.apply === 'completed' &&
    evidence.guild_blueprint_evidence === 'verified' &&
    callerOwnedBot &&
    bindingVerified &&
    cleanProfile &&
    cleanupVerified &&
    isolatedSession &&
    dangerousPermissions === false &&
    buildDigests !== null &&
    DIGEST.test(configDigest) &&
    DIGEST.test(sessionDigest) &&
    activityEvidence !== null &&
    executionProvenance.execution_mode === request.executionMode &&
    executionProvenance.abortable === true &&
    sessionClosed &&
    baselineRestored &&
    durations.total < request.maxDurationMs;
  let passed = candidatePass;
  if (candidatePass) {
    try {
      if (typeof dependencies.persistAttestation !== 'function')
        throw new Error('attestation persistence adapter is required');
      const envelope = {
        schema_version: 'discord-mcp.activation-attestation.v1',
        context: 'discord-mcp.activation-attestation:hmac:v1',
        run_id: request.runId,
        trial_id: request.trialId,
        host,
        host_version: request.hostVersion,
        release: request.release,
        source_commit: request.sourceCommit,
        binding: { guild_id: request.target.guildId, bot_id: request.target.botId },
        execution_provenance: executionProvenance,
        profile: {
          kind: 'clean_temp',
          config_digest: configDigest,
          cleanup_verified: cleanupVerified,
          token_persisted: false,
        },
        build: buildDigests,
        guild_blueprint_evidence: activityEvidence,
        evidence_digest: canonicalActivationEvidenceDigest(activityEvidence),
        baseline: {
          before_digest: beforeDigest,
          after_digest: afterDigest,
          restored: true,
          exact: true,
        },
        public_trial_digest: `sha256:${'0'.repeat(64)}`,
      };
      const unsignedPayload = {
        schema_version: 'discord-mcp.activation-trial.v2',
        host,
        host_version: request.hostVersion,
        release: request.release,
        source_commit: request.sourceCommit,
        trial_id: request.trialId,
        execution_mode: request.executionMode,
        result: 'passed',
        phase_durations_ms: durations,
        readiness,
        terminal_status: 'passed',
        evidence,
        digests: { build: buildDigest, evidence: evidenceDigest, session: sessionDigest },
        safety: {
          secret_free: true,
          caller_owned_bot: callerOwnedBot,
          binding_verified: bindingVerified,
          clean_profile: cleanProfile,
          isolated_session: isolatedSession,
          dangerous_permissions: dangerousPermissions,
        },
        baseline: {
          restored: baselineRestored,
          exact: baselineRestored,
          before_digest: beforeDigest,
          after_digest: afterDigest,
        },
      };
      const publicTrialDigest = activationTrialDigest(unsignedPayload);
      envelope.public_trial_digest = publicTrialDigest;
      const privateAttestation = createActivationAttestation({
        envelope,
        integrityKey: request.token,
      });
      const verifiedAttestation = verifyActivationAttestation({
        attestation: privateAttestation,
        integrityKey: request.token,
        validateActivityEvidence: (value) =>
          activityEvidenceValidated &&
          canonicalActivationEvidenceDigest(value) ===
            canonicalActivationEvidenceDigest(activityEvidence),
      });
      privateEnvelopeDigest = canonicalActivationAttestationDigest(verifiedAttestation);
      const persisted = await boundedCall('persistAttestation', ({ signal }) =>
        dependencies.persistAttestation({
          runId: request.runId,
          trialId: request.trialId,
          attestation: verifiedAttestation,
          digest: privateEnvelopeDigest,
          signal,
        }),
      );
      if (persisted?.persisted !== true || persisted.digest !== privateEnvelopeDigest)
        throw new Error('private attestation persistence was not confirmed');
    } catch {
      passed = false;
    }
  }
  const payload = {
    schema_version: 'discord-mcp.activation-trial.v2',
    host,
    host_version: request.hostVersion,
    release: request.release,
    source_commit: request.sourceCommit,
    trial_id: request.trialId,
    execution_mode: request.executionMode,
    result: passed ? 'passed' : 'failed',
    phase_durations_ms: durations,
    readiness,
    terminal_status: passed ? 'passed' : timedOut ? 'timeout' : 'failed',
    evidence,
    digests: { build: buildDigest, evidence: evidenceDigest, session: sessionDigest },
    safety: {
      secret_free: true,
      caller_owned_bot: callerOwnedBot,
      binding_verified: bindingVerified,
      clean_profile: cleanProfile,
      isolated_session: isolatedSession,
      dangerous_permissions: dangerousPermissions,
    },
    baseline: {
      restored: baselineRestored,
      exact: baselineRestored,
      before_digest: beforeDigest,
      after_digest: afterDigest,
    },
  };
  const artifact = createActivationTrialArtifact({
    ...payload,
    attestation: {
      schema_version: 'discord-mcp.activation-attestation-ref.v1',
      envelope_digest: privateEnvelopeDigest,
      trial_digest: activationTrialDigest(payload),
    },
  });
  return { ok: passed, artifact };
}
