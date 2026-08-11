import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BlueprintCheckpointStore,
  BlueprintCheckpointStoreError,
  loadAuthenticatedBlueprintCheckpoint,
} from './blueprint.checkpoint-store.js';
import { type BlueprintCheckpoint, emptyBlueprintBindings } from './blueprint.execution.schema.js';

const PLAN_ID = `sha256:${'a'.repeat(64)}`;
const otherPlanId = `sha256:${'b'.repeat(64)}`;
const BLUEPRINT_ID = `sha256:${'c'.repeat(64)}`;
const SIGNING_SECRET = 'test-checkpoint-signing-secret';
const directories: string[] = [];

function makeDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'discord-mcp-blueprint-checkpoint-'));
  directories.push(directory);
  return directory;
}

function checkpoint(version: number): BlueprintCheckpoint {
  return {
    schema_version: 'guild_blueprint_checkpoint.v1',
    plan_id: PLAN_ID,
    blueprint_id: BLUEPRINT_ID,
    target: {
      guild_id: '100000000000000001',
      bot_id: '100000000000000002',
    },
    version,
    status: version === 0 ? 'applying' : 'partial',
    bindings: emptyBlueprintBindings(),
    completed_operation_ids: version === 0 ? [] : ['roles:ensure:member'],
    last_error: null,
  };
}

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('BlueprintCheckpointStore', () => {
  it('writes immutable versioned checkpoints and loads the highest version', async () => {
    const stateDirectory = makeDirectory();
    const store = new BlueprintCheckpointStore({
      stateDirectory,
      planId: PLAN_ID,
      signingSecret: SIGNING_SECRET,
    });

    await store.save(checkpoint(0));
    await store.save(checkpoint(1));

    await expect(store.load()).resolves.toMatchObject({ version: 1 });
    await expect(store.save(checkpoint(1))).rejects.toMatchObject({
      code: 'CHECKPOINT_VERSION_CONFLICT',
    });

    if (process.platform !== 'win32') {
      const planDirectory = join(stateDirectory, 'a'.repeat(64));
      expect(statSync(planDirectory).mode & 0o777).toBe(0o700);
      expect(statSync(join(planDirectory, 'checkpoint-v1.json')).mode & 0o777).toBe(0o600);
    }
  });

  it('loads the highest authenticated checkpoint through the narrow loader seam', async () => {
    const stateDirectory = makeDirectory();
    const store = new BlueprintCheckpointStore({
      stateDirectory,
      planId: PLAN_ID,
      signingSecret: SIGNING_SECRET,
    });

    await store.save(checkpoint(0));
    await store.save(checkpoint(1));

    await expect(
      loadAuthenticatedBlueprintCheckpoint({
        stateDirectory,
        planId: PLAN_ID,
        signingSecret: SIGNING_SECRET,
      }),
    ).resolves.toMatchObject({ version: 1 });
  });

  it('fails closed through the loader seam for a wrong secret and tampering', async () => {
    const stateDirectory = makeDirectory();
    const store = new BlueprintCheckpointStore({
      stateDirectory,
      planId: PLAN_ID,
      signingSecret: SIGNING_SECRET,
    });
    await store.save(checkpoint(0));

    await expect(
      loadAuthenticatedBlueprintCheckpoint({
        stateDirectory,
        planId: PLAN_ID,
        signingSecret: 'wrong-checkpoint-signing-secret',
      }),
    ).rejects.toMatchObject({ code: 'CHECKPOINT_TAMPERED' });

    const planDirectory = join(stateDirectory, 'a'.repeat(64));
    const envelope = JSON.parse(
      readFileSync(join(planDirectory, 'checkpoint-v0.json'), 'utf8'),
    ) as { checkpoint: { version: number }; auth_tag: string };
    envelope.checkpoint.version = 1;
    writeFileSync(join(planDirectory, 'checkpoint-v1.json'), JSON.stringify(envelope), {
      mode: 0o600,
    });

    await expect(
      loadAuthenticatedBlueprintCheckpoint({
        stateDirectory,
        planId: PLAN_ID,
        signingSecret: SIGNING_SECRET,
      }),
    ).rejects.toMatchObject({ code: 'CHECKPOINT_TAMPERED' });
  });

  it('fails closed when the highest checkpoint is malformed', async () => {
    const stateDirectory = makeDirectory();
    const store = new BlueprintCheckpointStore({
      stateDirectory,
      planId: PLAN_ID,
      signingSecret: SIGNING_SECRET,
    });
    await store.save(checkpoint(0));
    const planDirectory = join(stateDirectory, 'a'.repeat(64));
    writeFileSync(join(planDirectory, 'checkpoint-v1.json'), '{not-json', { mode: 0o600 });

    await expect(store.load()).rejects.toMatchObject({ code: 'CHECKPOINT_MALFORMED' });
  });

  it('fails closed when a schema-valid checkpoint envelope is modified', async () => {
    const stateDirectory = makeDirectory();
    const store = new BlueprintCheckpointStore({
      stateDirectory,
      planId: PLAN_ID,
      signingSecret: SIGNING_SECRET,
    });
    await store.save(checkpoint(0));
    const planDirectory = join(stateDirectory, 'a'.repeat(64));
    const envelope = JSON.parse(
      readFileSync(join(planDirectory, 'checkpoint-v0.json'), 'utf8'),
    ) as {
      checkpoint: {
        version: number;
        bindings: { roles: Record<string, string> };
      };
      auth_tag: string;
    };
    envelope.checkpoint.version = 1;
    envelope.checkpoint.bindings.roles.member = '100000000000000099';
    writeFileSync(join(planDirectory, 'checkpoint-v1.json'), JSON.stringify(envelope), {
      mode: 0o600,
    });

    await expect(store.load()).rejects.toMatchObject({ code: 'CHECKPOINT_TAMPERED' });
  });

  it('rejects an invalid plan id before deriving state paths', () => {
    expect(
      () =>
        new BlueprintCheckpointStore({
          stateDirectory: join(makeDirectory(), 'safe'),
          planId: '../escape',
          signingSecret: SIGNING_SECRET,
        }),
    ).toThrow(BlueprintCheckpointStoreError);
  });

  it('returns busy for a live lock and releases only its own lock', async () => {
    const stateDirectory = makeDirectory();
    const first = new BlueprintCheckpointStore({
      stateDirectory,
      planId: PLAN_ID,
      signingSecret: SIGNING_SECRET,
    });
    const second = new BlueprintCheckpointStore({
      stateDirectory,
      planId: PLAN_ID,
      signingSecret: SIGNING_SECRET,
    });
    const lock = await first.tryAcquireLock();
    expect(lock.acquired).toBe(true);
    await expect(second.tryAcquireLock()).resolves.toEqual({ acquired: false, reason: 'busy' });

    if (lock.acquired) await lock.release();
    const reacquired = await second.tryAcquireLock();
    expect(reacquired.acquired).toBe(true);
    if (reacquired.acquired) await reacquired.release();
  });

  it('reclaims only a validated stale lock', async () => {
    const stateDirectory = makeDirectory();
    let now = Date.now();
    const store = new BlueprintCheckpointStore({
      stateDirectory,
      planId: PLAN_ID,
      signingSecret: SIGNING_SECRET,
      now: () => now,
    });
    const lock = await store.tryAcquireLock();
    expect(lock.acquired).toBe(true);
    if (lock.acquired) {
      await lock.release();
    }

    const planDirectory = join(stateDirectory, 'a'.repeat(64));
    const stale = new BlueprintCheckpointStore({
      stateDirectory,
      planId: PLAN_ID,
      signingSecret: SIGNING_SECRET,
      now: () => now,
    });
    const held = await stale.tryAcquireLock();
    expect(held.acquired).toBe(true);
    const lockPath = join(planDirectory, 'apply.lock');
    const record = JSON.parse(readFileSync(lockPath, 'utf8')) as { created_at_ms: number };
    writeFileSync(lockPath, JSON.stringify({ ...record, created_at_ms: 0, pid: 2_147_483_647 }), {
      mode: 0o600,
    });
    // A dead owner gets a short grace period, then can be resumed within the
    // benchmark's bounded 31-second recovery schedule.
    now += 14_000;
    await expect(stale.tryAcquireLock()).resolves.toEqual({ acquired: false, reason: 'busy' });
    now += 2_000;
    const reclaimed = await stale.tryAcquireLock();
    expect(reclaimed.acquired).toBe(true);
    if (reclaimed.acquired) await reclaimed.release();
    if (held.acquired) await held.release();
  });

  it('heartbeats an owned live lock so it cannot be reclaimed', async () => {
    const stateDirectory = makeDirectory();
    let now = Date.now();
    const owner = new BlueprintCheckpointStore({
      stateDirectory,
      planId: PLAN_ID,
      signingSecret: SIGNING_SECRET,
      now: () => now,
    });
    const contender = new BlueprintCheckpointStore({
      stateDirectory,
      planId: PLAN_ID,
      signingSecret: SIGNING_SECRET,
      now: () => now,
    });
    const lock = await owner.tryAcquireLock();
    expect(lock.acquired).toBe(true);
    if (!lock.acquired) return;

    now += 4 * 60_000;
    await expect(lock.heartbeat()).resolves.toBe(true);
    now += 4 * 60_000;
    await expect(contender.tryAcquireLock()).resolves.toEqual({ acquired: false, reason: 'busy' });
    await lock.release();
  });

  it('does not reclaim malformed locks, even when old', async () => {
    const stateDirectory = makeDirectory();
    let now = Date.now();
    const store = new BlueprintCheckpointStore({
      stateDirectory,
      planId: PLAN_ID,
      signingSecret: SIGNING_SECRET,
      now: () => now,
    });
    const lock = await store.tryAcquireLock();
    expect(lock.acquired).toBe(true);
    const lockPath = join(stateDirectory, 'a'.repeat(64), 'apply.lock');
    writeFileSync(lockPath, '{malformed', { mode: 0o600 });
    now += 10 * 60_000;
    await expect(store.tryAcquireLock()).resolves.toEqual({ acquired: false, reason: 'busy' });
    if (lock.acquired) await lock.release();
  });

  it('does not accept a checkpoint belonging to another plan', async () => {
    const stateDirectory = makeDirectory();
    const store = new BlueprintCheckpointStore({
      stateDirectory,
      planId: PLAN_ID,
      signingSecret: SIGNING_SECRET,
    });
    await expect(store.save({ ...checkpoint(0), plan_id: otherPlanId })).rejects.toMatchObject({
      code: 'INVALID_CHECKPOINT',
    });
  });
});
