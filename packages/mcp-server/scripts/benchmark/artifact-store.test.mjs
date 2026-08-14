import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  rmdir,
  stat,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { homedir, hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';

import {
  acquireCampaignLock as acquireRawCampaignLock,
  baselineArtifactExists,
  campaignLockConfirmation,
  defaultCampaignLockRoot,
  ensureArtifactRoot,
  prepareArtifactStore,
  readBaselineArtifact,
  recoverCampaignLock,
  recoverLegacyBaselineArtifact,
  writeActivationAttestationArtifact,
  writeBaselineArtifact,
} from './artifact-store.mjs';

const temporaryDirectories = [];
let windowsTemporaryRootPromise;
const INTEGRITY_KEY = 'benchmark-artifact-test-key';
const LOCK_COMMIT = 'babe8518767270733e5442643690cac13f94e473';
const LOCK_STARTED_AT = '2026-08-14T04:03:25.930Z';
const LOCK_BOT_ID = '1533457669384306858';
const LOCK_GUILD_IDS = ['1533989004406558851', '1533998797863256165'];
const LOCK_ROOT = join(
  process.platform === 'win32' ? homedir() : tmpdir(),
  `discord-mcp-campaign-lock-tests-${process.pid}`,
);

function lockOwner(runId, fields = {}) {
  return { run_id: runId, commit: LOCK_COMMIT, started_at: LOCK_STARTED_AT, ...fields };
}

function acquireCampaignLock(options) {
  return acquireRawCampaignLock({
    ...options,
    lockRoot: options.lockRoot ?? LOCK_ROOT,
    botId: LOCK_BOT_ID,
    guildIds: options.guildIds ?? LOCK_GUILD_IDS,
  });
}

async function directory(name) {
  let base;
  if (process.platform === 'win32') {
    if (!windowsTemporaryRootPromise) {
      windowsTemporaryRootPromise = mkdtemp(join(homedir(), 'discord-mcp-test-'));
    }
    base = await windowsTemporaryRootPromise;
  } else {
    base = tmpdir();
  }
  const path = await mkdtemp(join(base, name));
  temporaryDirectories.push(path);
  return path;
}

async function createSymlink(target, path, symlinkType, skip) {
  try {
    const type =
      process.platform === 'win32' ? symlinkType : symlinkType === 'junction' ? 'dir' : 'file';
    await symlink(target, path, type);
    return true;
  } catch (error) {
    if (process.platform === 'win32' && ['EACCES', 'EPERM', 'UNKNOWN'].includes(error?.code)) {
      skip();
      return false;
    }
    throw error;
  }
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
  await rm(LOCK_ROOT, { recursive: true, force: true });
});

afterAll(async () => {
  if (windowsTemporaryRootPromise) {
    await rm(await windowsTemporaryRootPromise, { recursive: true, force: true });
  }
});

describe('benchmark artifact store', () => {
  it('persists private activation attestations by digest under the campaign run', async () => {
    const cwd = await directory('discord-mcp-activation-source-');
    const artifactRoot = await directory('discord-mcp-activation-artifacts-');
    const digest = `sha256:${'a'.repeat(64)}`;
    const attestation = {
      schema_version: 'discord-mcp.activation-attestation.v1',
      run_id: 'activation-run-001',
      trial_id: 'trial-001',
    };

    const written = await writeActivationAttestationArtifact({
      cwd,
      artifactRoot,
      runId: attestation.run_id,
      trialId: attestation.trial_id,
      digest,
      attestation,
    });

    expect(written).toMatchObject({ persisted: true, digest });
    await expect(
      readFile(join(written.evidenceDirectory, `${'a'.repeat(64)}.json`), 'utf8'),
    ).resolves.toContain('discord-mcp.activation-attestation.v1');
    await expect(
      writeActivationAttestationArtifact({
        cwd,
        artifactRoot,
        runId: attestation.run_id,
        trialId: attestation.trial_id,
        digest,
        attestation: { ...attestation, trial_id: 'trial-002' },
      }),
    ).rejects.toThrow(/identity/);
  });

  it('locks the controlled pool across artifact roots and releases on success or failure', async () => {
    const cwd = await directory('discord-mcp-campaign-lock-source-');
    const artifactRoot = await directory('discord-mcp-campaign-lock-');
    const secondArtifactRoot = await directory('discord-mcp-campaign-lock-second-');
    const first = await acquireCampaignLock({
      cwd,
      artifactRoot,
      owner: lockOwner('run-01'),
    });
    await expect(
      acquireCampaignLock({
        cwd,
        artifactRoot: secondArtifactRoot,
        guildIds: [...LOCK_GUILD_IDS].reverse(),
        owner: lockOwner('run-02'),
      }),
    ).rejects.toThrow(/run-01/);
    await first.release();

    const second = await acquireCampaignLock({
      cwd,
      artifactRoot: secondArtifactRoot,
      owner: lockOwner('run-02'),
    });
    await second.release();

    const failed = await acquireCampaignLock({
      cwd,
      artifactRoot: secondArtifactRoot,
      owner: lockOwner('run-03'),
    });
    try {
      throw new Error('simulated campaign failure');
    } catch {
      await failed.release();
    }
    const fourth = await acquireCampaignLock({
      cwd,
      artifactRoot,
      owner: lockOwner('run-04'),
    });
    expect(fourth).toBeTruthy();
    await fourth.release();
  });

  it('uses a caller-profile default lock root and explicit identity-bound recovery', async () => {
    const homeDirectory = await directory('discord-mcp-lock-home-');
    expect(defaultCampaignLockRoot({ homeDirectory })).toBe(
      join(homeDirectory, '.discord-mcp', 'locks'),
    );

    const cwd = await directory('discord-mcp-campaign-lock-recovery-source-');
    const artifactRoot = await directory('discord-mcp-campaign-lock-recovery-');
    const owner = lockOwner('run-recovery');
    const recordedOwner = lockOwner('run-recovery', { pid: 999999999, hostname: hostname() });
    const lock = await acquireCampaignLock({ cwd, artifactRoot, owner });
    const confirmation = campaignLockConfirmation({
      botId: LOCK_BOT_ID,
      guildIds: LOCK_GUILD_IDS,
    });
    await writeFile(
      join(lock.lockPath, 'owner.json'),
      `${JSON.stringify(recordedOwner)}\n`,
      'utf8',
    );

    await expect(lock.release()).rejects.toThrow(/metadata changed/);

    await expect(
      recoverCampaignLock({
        lockRoot: LOCK_ROOT,
        botId: LOCK_BOT_ID,
        guildIds: LOCK_GUILD_IDS,
        owner: recordedOwner,
        confirmation: 'RELEASE_DISCORD_MCP_LOCK:wrong',
      }),
    ).rejects.toThrow(/confirmation/);
    await expect(
      recoverCampaignLock({
        lockRoot: LOCK_ROOT,
        botId: LOCK_BOT_ID,
        guildIds: LOCK_GUILD_IDS,
        owner: lockOwner('different-owner', { pid: 999999999, hostname: hostname() }),
        confirmation,
      }),
    ).rejects.toThrow(/owner does not match/);

    const recovery = await recoverCampaignLock({
      lockRoot: LOCK_ROOT,
      botId: LOCK_BOT_ID,
      guildIds: LOCK_GUILD_IDS,
      owner: recordedOwner,
      confirmation,
    });
    expect(recovery).toMatchObject({ lockPath: lock.lockPath, owner: recordedOwner });
    await expect(stat(recovery.quarantinePath)).resolves.toBeDefined();
    await expect(stat(lock.lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lock.release()).rejects.toThrow();
    const replacement = await acquireCampaignLock({
      cwd,
      artifactRoot,
      owner: lockOwner('run-after-recovery'),
    });
    await replacement.release();
  });

  it('requires the complete recorded owner for recovery', async () => {
    const cwd = await directory('discord-mcp-campaign-lock-full-owner-source-');
    const artifactRoot = await directory('discord-mcp-campaign-lock-full-owner-');
    const lock = await acquireCampaignLock({
      cwd,
      artifactRoot,
      owner: lockOwner('run-full-owner'),
    });
    await expect(
      recoverCampaignLock({
        lockRoot: LOCK_ROOT,
        botId: LOCK_BOT_ID,
        guildIds: LOCK_GUILD_IDS,
        owner: lockOwner('run-full-owner'),
        confirmation: campaignLockConfirmation({
          botId: LOCK_BOT_ID,
          guildIds: LOCK_GUILD_IDS,
        }),
      }),
    ).rejects.toThrow(/unexpected fields/);
    await lock.release();
  });

  it('binds acquisition process identity instead of trusting caller-supplied values', async () => {
    const cwd = await directory('discord-mcp-campaign-lock-identity-source-');
    const artifactRoot = await directory('discord-mcp-campaign-lock-identity-');
    await expect(
      acquireCampaignLock({
        cwd,
        artifactRoot,
        owner: lockOwner('run-spoofed-identity', {
          pid: 999999999,
          hostname: hostname(),
        }),
      }),
    ).rejects.toThrow(/must not provide pid or hostname/);

    const lock = await acquireCampaignLock({
      cwd,
      artifactRoot,
      owner: lockOwner('run-bound-identity'),
    });
    try {
      const recorded = JSON.parse(await readFile(join(lock.lockPath, 'owner.json'), 'utf8'));
      expect(recorded).toMatchObject({ pid: process.pid, hostname: hostname() });
    } finally {
      await lock.release();
    }
  });

  it('never recovers an orphaned or malformed lock without valid owner metadata', async () => {
    const cwd = await directory('discord-mcp-campaign-lock-orphan-recovery-source-');
    const artifactRoot = await directory('discord-mcp-campaign-lock-orphan-recovery-');
    const owner = lockOwner('run-orphan-recovery');
    const recordedOwner = lockOwner('run-orphan-recovery', {
      pid: 999999999,
      hostname: hostname(),
    });
    const lock = await acquireCampaignLock({ cwd, artifactRoot, owner });
    await unlink(join(lock.lockPath, 'owner.json'));
    const confirmation = campaignLockConfirmation({
      botId: LOCK_BOT_ID,
      guildIds: LOCK_GUILD_IDS,
    });
    await expect(
      recoverCampaignLock({
        lockRoot: LOCK_ROOT,
        botId: LOCK_BOT_ID,
        guildIds: LOCK_GUILD_IDS,
        owner: recordedOwner,
        confirmation,
      }),
    ).rejects.toThrow(/valid owner metadata/);
    await expect(stat(lock.lockPath)).resolves.toBeDefined();
    await rmdir(lock.lockPath);
  });

  it('never removes an explicit lock when an unexpected child appears', async () => {
    const cwd = await directory('discord-mcp-campaign-lock-recovery-child-source-');
    const artifactRoot = await directory('discord-mcp-campaign-lock-recovery-child-');
    const owner = lockOwner('run-recovery-child');
    const recordedOwner = lockOwner('run-recovery-child', {
      pid: 999999999,
      hostname: hostname(),
    });
    const lock = await acquireCampaignLock({ cwd, artifactRoot, owner });
    await writeFile(join(lock.lockPath, 'unexpected'), 'do not remove', 'utf8');
    await writeFile(
      join(lock.lockPath, 'owner.json'),
      `${JSON.stringify(recordedOwner)}\n`,
      'utf8',
    );
    const recovery = await recoverCampaignLock({
      lockRoot: LOCK_ROOT,
      botId: LOCK_BOT_ID,
      guildIds: LOCK_GUILD_IDS,
      owner: recordedOwner,
      confirmation: campaignLockConfirmation({
        botId: LOCK_BOT_ID,
        guildIds: LOCK_GUILD_IDS,
      }),
    });
    await expect(readFile(join(recovery.quarantinePath, 'owner.json'), 'utf8')).resolves.toContain(
      recordedOwner.run_id,
    );
    await expect(readFile(join(recovery.quarantinePath, 'unexpected'), 'utf8')).resolves.toBe(
      'do not remove',
    );
    await expect(stat(lock.lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps separate explicit lock scopes independent', async () => {
    const cwd = await directory('discord-mcp-campaign-lock-scope-source-');
    const artifactRoot = await directory('discord-mcp-campaign-lock-scope-');
    const secondLockRoot = await directory('discord-mcp-campaign-lock-scope-second-');
    const first = await acquireCampaignLock({ cwd, artifactRoot, owner: lockOwner('run-scope-1') });
    const second = await acquireCampaignLock({
      cwd,
      artifactRoot,
      lockRoot: secondLockRoot,
      owner: lockOwner('run-scope-2'),
    });
    await first.release();
    await second.release();
  });

  it('enforces private artifact roots with POSIX mode and Windows profile policy', async () => {
    const cwd = await directory('discord-mcp-private-root-source-');
    const posixRoot = await directory('discord-mcp-private-root-posix-');
    const nestedComponents = ['level-one', 'level-two', 'artifacts'];
    const resolved = await ensureArtifactRoot({
      cwd,
      artifactRoot: join(posixRoot, ...nestedComponents),
      platform: process.platform,
    });
    await expect(stat(resolved)).resolves.toMatchObject({ mode: expect.any(Number) });
    if (process.platform !== 'win32') {
      for (let index = 1; index <= nestedComponents.length; index += 1) {
        const mode =
          (await stat(join(posixRoot, ...nestedComponents.slice(0, index)))).mode & 0o777;
        expect(mode).toBe(0o700);
      }
    }

    const homeDirectory = await directory('discord-mcp-private-root-home-');
    const outsideRoot = await directory('discord-mcp-private-root-outside-');
    await expect(
      ensureArtifactRoot({
        cwd,
        artifactRoot: join(outsideRoot, 'artifacts'),
        platform: 'win32',
        homeDirectory,
      }),
    ).rejects.toThrow(/caller profile/);
    await expect(
      ensureArtifactRoot({
        cwd,
        artifactRoot: join(homeDirectory, 'artifacts'),
        platform: 'win32',
        homeDirectory,
      }),
    ).resolves.toBe(join(homeDirectory, 'artifacts'));
  });

  it('keeps custom Windows lock roots inside the caller profile', async () => {
    const cwd = await directory('discord-mcp-lock-profile-source-');
    const artifactRoot = await directory('discord-mcp-lock-profile-artifacts-');
    const homeDirectory = await directory('discord-mcp-lock-profile-home-');
    const outsideRoot = await directory('discord-mcp-lock-profile-outside-');
    const confirmation = campaignLockConfirmation({
      botId: LOCK_BOT_ID,
      guildIds: LOCK_GUILD_IDS,
    });
    await expect(
      acquireCampaignLock({
        cwd,
        artifactRoot,
        lockRoot: join(outsideRoot, 'locks'),
        platform: 'win32',
        homeDirectory,
        owner: lockOwner('run-outside-profile'),
      }),
    ).rejects.toThrow(/caller profile/);
    await expect(
      recoverCampaignLock({
        lockRoot: join(outsideRoot, 'locks'),
        platform: 'win32',
        homeDirectory,
        botId: LOCK_BOT_ID,
        guildIds: LOCK_GUILD_IDS,
        owner: lockOwner('run-outside-profile', {
          pid: 999999999,
          hostname: hostname(),
        }),
        confirmation,
      }),
    ).rejects.toThrow(/caller profile/);

    const lock = await acquireCampaignLock({
      cwd,
      artifactRoot,
      lockRoot: join(homeDirectory, '.discord-mcp', 'locks'),
      platform: 'win32',
      homeDirectory,
      owner: lockOwner('run-inside-profile'),
    });
    await lock.release();
  });

  it('fails closed with inspectable owner metadata after an abandoned lock', async () => {
    const cwd = await directory('discord-mcp-campaign-lock-orphan-source-');
    const artifactRoot = await directory('discord-mcp-campaign-lock-orphan-');
    const secondArtifactRoot = await directory('discord-mcp-campaign-lock-orphan-second-');
    const owner = lockOwner('run-orphan');
    const orphan = await acquireCampaignLock({ cwd, artifactRoot, owner });
    try {
      await expect(
        acquireCampaignLock({
          cwd,
          artifactRoot: secondArtifactRoot,
          owner: lockOwner('run-next'),
        }),
      ).rejects.toThrow(/run-orphan/);
      await expect(readFile(join(orphan.lockPath, 'owner.json'), 'utf8')).resolves.toContain(
        'run-orphan',
      );
    } finally {
      await unlink(join(orphan.lockPath, 'owner.json'));
      await rmdir(orphan.lockPath);
    }
  });

  it('fails closed before reading an oversized campaign lock owner', async () => {
    const cwd = await directory('discord-mcp-campaign-lock-oversized-source-');
    const artifactRoot = await directory('discord-mcp-campaign-lock-oversized-');
    const secondArtifactRoot = await directory('discord-mcp-campaign-lock-oversized-second-');
    const orphan = await acquireCampaignLock({
      cwd,
      artifactRoot,
      owner: lockOwner('run-oversized'),
    });
    try {
      await writeFile(join(orphan.lockPath, 'owner.json'), 'x'.repeat(64 * 1024), 'utf8');
      await expect(
        acquireCampaignLock({
          cwd,
          artifactRoot: secondArtifactRoot,
          owner: lockOwner('run-next'),
        }),
      ).rejects.toThrow(/owner metadata is unavailable/);
    } finally {
      await unlink(join(orphan.lockPath, 'owner.json'));
      await rmdir(orphan.lockPath);
    }
  });

  it('rejects a symlinked campaign lock path', async ({ skip }) => {
    const cwd = await directory('discord-mcp-campaign-lock-symlink-source-');
    const artifactRoot = await directory('discord-mcp-campaign-lock-symlink-');
    const externalRoot = await directory('discord-mcp-campaign-lock-symlink-external-');
    const probe = await acquireCampaignLock({ cwd, artifactRoot, owner: lockOwner('run-probe') });
    const lockPath = probe.lockPath;
    await probe.release();
    if (!(await createSymlink(externalRoot, lockPath, 'junction', skip))) return;
    try {
      await expect(
        acquireCampaignLock({ cwd, artifactRoot, owner: lockOwner('run-01') }),
      ).rejects.toThrow(/symlink/);
    } finally {
      await unlink(lockPath);
    }
  });

  it('creates an exclusive outside-repository run and fresh state directories', async () => {
    const cwd = await directory('discord-mcp-artifact-source-');
    const artifactRoot = await directory('discord-mcp-artifacts-');
    const store = await prepareArtifactStore({ cwd, artifactRoot, runId: 'run-01' });

    await store.writeArtifact('results/trial-01.json', { status: 'complete' });
    await expect(
      store.writeArtifact('results/trial-01.json', { status: 'overwrite' }),
    ).rejects.toThrow();
    const state = await store.createStateDirectory('trial-01');
    expect(state).toBe(join(store.runDirectory, 'state', 'trial-01'));
    await expect(store.createStateDirectory('trial-01')).rejects.toThrow();
  });

  it('rejects repository-local roots, traversal, and secret-bearing artifacts', async () => {
    const cwd = await directory('discord-mcp-artifact-local-');
    await expect(
      prepareArtifactStore({ cwd, artifactRoot: join(cwd, 'artifacts'), runId: 'run-01' }),
    ).rejects.toThrow(/outside|inside/);
    const artifactRoot = await directory('discord-mcp-artifact-safe-');
    const store = await prepareArtifactStore({ cwd, artifactRoot, runId: 'run-01' });
    await expect(store.writeArtifact('../escape.json', {})).rejects.toThrow(/relative/);
    await expect(store.writeArtifact('token.json', { token: 'secret' })).rejects.toThrow(/Secret/);
  });

  it('rejects symlinked artifact directories and targets before writing or creating state', async ({
    skip,
  }) => {
    const cwd = await directory('discord-mcp-artifact-symlink-source-');
    const artifactRoot = await directory('discord-mcp-artifact-symlink-');
    const externalRoot = await directory('discord-mcp-artifact-symlink-external-');
    const store = await prepareArtifactStore({ cwd, artifactRoot, runId: 'run-01' });

    const externalState = join(externalRoot, 'state-target');
    await mkdir(externalState);
    if (
      !(await createSymlink(
        externalState,
        join(store.runDirectory, 'state', 'trial-01'),
        'junction',
        skip,
      ))
    )
      return;
    await expect(store.createStateDirectory('trial-01')).rejects.toThrow(/symlink/);

    const externalResults = join(externalRoot, 'results-target');
    await mkdir(externalResults);
    await rm(join(store.runDirectory, 'results'), { recursive: true, force: true });
    if (
      !(await createSymlink(externalResults, join(store.runDirectory, 'results'), 'junction', skip))
    )
      return;
    await expect(
      store.writeArtifact('results/trial-01.json', { status: 'blocked' }),
    ).rejects.toThrow(/symlink/);
    await expect(readFile(join(externalResults, 'trial-01.json'))).rejects.toThrow();
  });

  it('rejects a symlinked artifact target before writing', async ({ skip }) => {
    const cwd = await directory('discord-mcp-artifact-target-source-');
    const artifactRoot = await directory('discord-mcp-artifact-target-');
    const externalRoot = await directory('discord-mcp-artifact-target-external-');
    const secondStore = await prepareArtifactStore({ cwd, artifactRoot, runId: 'run-02' });
    const externalTarget = join(externalRoot, 'target.json');
    await writeFile(externalTarget, '{"status":"untouched"}');
    if (
      !(await createSymlink(
        externalTarget,
        join(secondStore.runDirectory, 'results', 'trial-01.json'),
        'file',
        skip,
      ))
    )
      return;
    await expect(
      secondStore.writeArtifact('results/trial-01.json', { status: 'blocked' }),
    ).rejects.toThrow(/symlink/);
    await expect(readFile(externalTarget, 'utf8')).resolves.toBe('{"status":"untouched"}');
  });

  it('rejects a symlinked runs directory before creating a run', async ({ skip }) => {
    const cwd = await directory('discord-mcp-artifact-runs-source-');
    const artifactRoot = await directory('discord-mcp-artifact-runs-');
    const externalRuns = await directory('discord-mcp-artifact-runs-external-');
    if (!(await createSymlink(externalRuns, join(artifactRoot, 'runs'), 'junction', skip))) return;

    await expect(prepareArtifactStore({ cwd, artifactRoot, runId: 'run-01' })).rejects.toThrow(
      /symlink/,
    );
  });

  it('round-trips a bounded secret-free baseline without overwriting it', async () => {
    const cwd = await directory('discord-mcp-baseline-source-');
    const artifactRoot = await directory('discord-mcp-baseline-');
    const baseline = {
      guild_id: '999000999000999000',
      fingerprint: `sha256:${'a'.repeat(64)}`,
    };
    await expect(
      baselineArtifactExists({ cwd, artifactRoot, guildId: baseline.guild_id }),
    ).resolves.toBe(false);
    await writeBaselineArtifact({ cwd, artifactRoot, baseline, integrityKey: INTEGRITY_KEY });
    await expect(
      baselineArtifactExists({ cwd, artifactRoot, guildId: baseline.guild_id }),
    ).resolves.toBe(true);
    await expect(
      writeBaselineArtifact({ cwd, artifactRoot, baseline, integrityKey: INTEGRITY_KEY }),
    ).rejects.toThrow();
    await expect(
      readBaselineArtifact({
        cwd,
        artifactRoot,
        guildId: baseline.guild_id,
        integrityKey: INTEGRITY_KEY,
      }),
    ).resolves.toMatchObject({
      ...baseline,
      artifact_integrity: { algorithm: 'hmac-sha256', digest: expect.any(String) },
    });
  });

  it('rejects tampered restore fields before an artifact can be consumed', async () => {
    const cwd = await directory('discord-mcp-baseline-tamper-source-');
    const artifactRoot = await directory('discord-mcp-baseline-tamper-');
    const baseline = {
      schema_version: 1,
      kind: 'discord-mcp-benchmark-baseline',
      guild_id: '999000999000999000',
      bot_id: '888000888000888000',
      run_id: 'baseline-test',
      guild_fields: { name: 'original' },
      baseline_snapshot: { channels: [{ id: '777000777000999002', name: 'original' }] },
    };
    await writeBaselineArtifact({
      cwd,
      artifactRoot,
      baseline,
      integrityKey: INTEGRITY_KEY,
    });
    const path = join(artifactRoot, 'baselines', `${baseline.guild_id}.json`);
    const tampered = JSON.parse(await readFile(path, 'utf8'));
    tampered.guild_fields.name = 'attacker-controlled';
    tampered.baseline_snapshot.channels[0].name = 'attacker-controlled';
    await writeFile(path, `${JSON.stringify(tampered)}\n`, 'utf8');

    await expect(
      readBaselineArtifact({
        cwd,
        artifactRoot,
        guildId: baseline.guild_id,
        integrityKey: INTEGRITY_KEY,
      }),
    ).rejects.toThrow(/integrity/);
  });

  it('migrates a verified legacy artifact with an atomic backup', async () => {
    const cwd = await directory('discord-mcp-baseline-legacy-source-');
    const artifactRoot = await directory('discord-mcp-baseline-legacy-');
    const baseline = {
      guild_id: '999000999000999000',
      fingerprint: `sha256:${'a'.repeat(64)}`,
    };
    const baselines = join(artifactRoot, 'baselines');
    await mkdir(baselines);
    const path = join(baselines, `${baseline.guild_id}.json`);
    await writeFile(path, `${JSON.stringify(baseline)}\n`, 'utf8');

    const verified = [];
    const result = await recoverLegacyBaselineArtifact({
      cwd,
      artifactRoot,
      guildId: baseline.guild_id,
      integrityKey: INTEGRITY_KEY,
      verify: async (signed) => verified.push(signed),
    });

    expect(verified).toHaveLength(1);
    expect(verified[0]).toMatchObject({
      ...baseline,
      artifact_integrity: { algorithm: 'hmac-sha256', digest: expect.any(String) },
    });
    await expect(readFile(result.backupPath, 'utf8')).resolves.toBe(
      `${JSON.stringify(baseline)}\n`,
    );
    await expect(
      readBaselineArtifact({
        cwd,
        artifactRoot,
        guildId: baseline.guild_id,
        integrityKey: INTEGRITY_KEY,
      }),
    ).resolves.toMatchObject(verified[0]);
  });

  it('resumes a prior crash when the existing legacy backup is exact and unsigned', async () => {
    const cwd = await directory('discord-mcp-baseline-resume-source-');
    const artifactRoot = await directory('discord-mcp-baseline-resume-');
    const baseline = {
      guild_id: '999000999000999000',
      fingerprint: `sha256:${'a'.repeat(64)}`,
    };
    const baselines = join(artifactRoot, 'baselines');
    await mkdir(baselines);
    const path = join(baselines, `${baseline.guild_id}.json`);
    const legacyText = `${JSON.stringify(baseline)}\n`;
    await writeFile(path, legacyText, 'utf8');
    const backupPath = join(baselines, `${baseline.guild_id}.legacy.json`);
    await writeFile(backupPath, legacyText, 'utf8');

    const result = await recoverLegacyBaselineArtifact({
      cwd,
      artifactRoot,
      guildId: baseline.guild_id,
      integrityKey: INTEGRITY_KEY,
      verify: async () => undefined,
    });

    await expect(readFile(result.backupPath, 'utf8')).resolves.toBe(legacyText);
    await expect(
      readBaselineArtifact({
        cwd,
        artifactRoot,
        guildId: baseline.guild_id,
        integrityKey: INTEGRITY_KEY,
      }),
    ).resolves.toMatchObject(baseline);
  });

  it('refuses a mismatched existing backup without replacing either artifact', async () => {
    const cwd = await directory('discord-mcp-baseline-mismatched-backup-source-');
    const artifactRoot = await directory('discord-mcp-baseline-mismatched-backup-');
    const baseline = {
      guild_id: '999000999000999000',
      fingerprint: `sha256:${'a'.repeat(64)}`,
    };
    const mismatched = { ...baseline, fingerprint: `sha256:${'b'.repeat(64)}` };
    const baselines = join(artifactRoot, 'baselines');
    await mkdir(baselines);
    const path = join(baselines, `${baseline.guild_id}.json`);
    const legacyText = `${JSON.stringify(baseline)}\n`;
    const backupText = `${JSON.stringify(mismatched)}\n`;
    await writeFile(path, legacyText, 'utf8');
    const backupPath = join(baselines, `${baseline.guild_id}.legacy.json`);
    await writeFile(backupPath, backupText, 'utf8');

    await expect(
      recoverLegacyBaselineArtifact({
        cwd,
        artifactRoot,
        guildId: baseline.guild_id,
        integrityKey: INTEGRITY_KEY,
        verify: async () => undefined,
      }),
    ).rejects.toThrow(/backup does not match/);
    await expect(readFile(path, 'utf8')).resolves.toBe(legacyText);
    await expect(readFile(backupPath, 'utf8')).resolves.toBe(backupText);
  });

  it('refuses live-drift recovery before installing or backing up the legacy file', async () => {
    const cwd = await directory('discord-mcp-baseline-drift-source-');
    const artifactRoot = await directory('discord-mcp-baseline-drift-');
    const baseline = {
      guild_id: '999000999000999000',
      fingerprint: `sha256:${'a'.repeat(64)}`,
    };
    const baselines = join(artifactRoot, 'baselines');
    await mkdir(baselines);
    const path = join(baselines, `${baseline.guild_id}.json`);
    const legacyText = `${JSON.stringify(baseline)}\n`;
    await writeFile(path, legacyText, 'utf8');

    await expect(
      recoverLegacyBaselineArtifact({
        cwd,
        artifactRoot,
        guildId: baseline.guild_id,
        integrityKey: INTEGRITY_KEY,
        verify: async () => {
          throw new Error('BASELINE_FINGERPRINT_DRIFT');
        },
      }),
    ).rejects.toThrow('BASELINE_FINGERPRINT_DRIFT');
    await expect(readFile(path, 'utf8')).resolves.toBe(legacyText);
    await expect(readFile(join(baselines, `${baseline.guild_id}.legacy.json`))).rejects.toThrow();
  });

  it('refuses migration of an existing signed artifact', async () => {
    const cwd = await directory('discord-mcp-baseline-signed-source-');
    const artifactRoot = await directory('discord-mcp-baseline-signed-');
    const baseline = {
      guild_id: '999000999000999000',
      fingerprint: `sha256:${'a'.repeat(64)}`,
    };
    await writeBaselineArtifact({ cwd, artifactRoot, baseline, integrityKey: INTEGRITY_KEY });
    let verificationCalls = 0;
    await expect(
      recoverLegacyBaselineArtifact({
        cwd,
        artifactRoot,
        guildId: baseline.guild_id,
        integrityKey: INTEGRITY_KEY,
        verify: async () => {
          verificationCalls += 1;
        },
      }),
    ).rejects.toThrow(/already signed/);
    expect(verificationCalls).toBe(0);
  });

  it('rejects a baseline file whose embedded guild does not match the requested guild', async () => {
    const cwd = await directory('discord-mcp-baseline-bind-source-');
    const artifactRoot = await directory('discord-mcp-baseline-bind-');
    const requestedGuild = '999000999000999000';
    await mkdir(join(artifactRoot, 'baselines'));
    await writeFile(
      join(artifactRoot, 'baselines', `${requestedGuild}.json`),
      JSON.stringify({ guild_id: '999000999000999001' }),
    );

    await expect(
      readBaselineArtifact({ cwd, artifactRoot, guildId: requestedGuild }),
    ).rejects.toThrow(/guild_id/);
  });
});
