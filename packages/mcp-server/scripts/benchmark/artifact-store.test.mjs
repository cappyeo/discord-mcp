import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  baselineArtifactExists,
  prepareArtifactStore,
  readBaselineArtifact,
  recoverLegacyBaselineArtifact,
  writeBaselineArtifact,
} from './artifact-store.mjs';

const temporaryDirectories = [];
const INTEGRITY_KEY = 'benchmark-artifact-test-key';

async function directory(name) {
  const path = await mkdtemp(join(tmpdir(), name));
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
});

describe('benchmark artifact store', () => {
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
