import { createHmac } from 'node:crypto';
import {
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  emptyBlueprintBindings,
  type GuildBlueprintPlanPayload,
} from './blueprint.execution.schema.js';
import { compileGuildBlueprint } from './blueprint.js';
import {
  BlueprintPlanReferenceStoreError,
  loadBlueprintPlanReference,
  saveBlueprintPlanReference,
} from './blueprint.plan-reference-store.js';
import { encodeBlueprintPlan } from './blueprint.plan-token.js';
import { canonicalJson } from './blueprint.validation.js';

const SIGNING_SECRET = 'test-plan-reference-signing-secret';
const directories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'discord-mcp-plan-reference-'));
  directories.push(directory);
  return directory;
}

function payload(): GuildBlueprintPlanPayload {
  return {
    schema_version: 'guild_blueprint_plan.v1',
    policy_version: 'safe-reconcile.v1',
    target: { guild_id: '100000000000000001', bot_id: '100000000000000002' },
    blueprint_id: `sha256:${'1'.repeat(64)}`,
    blueprint: compileGuildBlueprint({
      request: 'Build a professional gaming community',
      requested_capabilities: ['gaming', 'lfg', 'voice'],
      primary: {
        code: 'primary',
        effective_capabilities: ['gaming', 'lfg', 'voice'],
        blueprint: {
          channel_count: 10,
          category_count: 2,
          text_channel_count: 6,
          voice_channel_count: 3,
          forum_channel_count: 0,
          stage_channel_count: 0,
          other_channel_count: 0,
          nsfw_channel_count: 0,
          permission_overwrite_count: 4,
          role_count: 4,
          privileged_role_count: 0,
          risky_permission_signals: [],
        },
      },
      inspirations: [],
    }),
    initial_snapshot_id: `sha256:${'2'.repeat(64)}`,
    initial_bindings: emptyBlueprintBindings(),
    initial_operations: [],
    policy: {
      deletions: false,
      ambiguous_matches: 'block',
      unbound_drift: 'block',
      auto_grant_bot_permissions: false,
      managed_roles: 'immutable',
      publication_idempotency: 'marker_and_discord_nonce',
    },
  };
}

function referencePath(stateDirectory: string, reference: string): string {
  return join(stateDirectory, 'plan-references-v1', `${reference.slice('dmbpr1.'.length)}.json`);
}

async function save(stateDirectory: string, plan = payload()): Promise<string> {
  return saveBlueprintPlanReference({
    stateDirectory,
    planId: encodeBlueprintPlan(plan, SIGNING_SECRET).plan_id,
    payload: plan,
    signingSecret: SIGNING_SECRET,
  });
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('Blueprint plan reference store', () => {
  it('round-trips across restarts and persists a payload rather than the raw plan token', async () => {
    const stateDirectory = temporaryDirectory();
    const plan = payload();
    const reference = await save(stateDirectory, plan);

    await expect(
      loadBlueprintPlanReference({
        stateDirectory,
        planRef: reference,
        signingSecret: SIGNING_SECRET,
      }),
    ).resolves.toEqual({
      payload: plan,
      plan_id: encodeBlueprintPlan(plan, SIGNING_SECRET).plan_id,
      approval_id: encodeBlueprintPlan(plan, SIGNING_SECRET).approval_id,
    });

    const onDisk = readFileSync(referencePath(stateDirectory, reference), 'utf8');
    expect(onDisk).not.toContain('plan_token');
    expect(onDisk).not.toContain('dmbp1.');
  });

  it('is deterministic and idempotent for the same payload', async () => {
    const stateDirectory = temporaryDirectory();
    const plan = payload();
    const first = await save(stateDirectory, plan);
    const second = await save(stateDirectory, plan);
    expect(first).toMatch(/^dmbpr1\.[a-f0-9]{64}$/);
    expect(second).toBe(first);

    if (process.platform !== 'win32') {
      expect(statSync(join(stateDirectory, 'plan-references-v1')).mode & 0o777).toBe(0o700);
      expect(statSync(referencePath(stateDirectory, first)).mode & 0o777).toBe(0o600);
    }
  });

  it('fails closed for tampering, a wrong secret, malformed data, and oversize records', async () => {
    const stateDirectory = temporaryDirectory();
    const reference = await save(stateDirectory);
    const path = referencePath(stateDirectory, reference);
    const envelope = JSON.parse(readFileSync(path, 'utf8')) as {
      payload: { initial_snapshot_id: string };
    };
    envelope.payload.initial_snapshot_id = `sha256:${'3'.repeat(64)}`;
    writeFileSync(path, JSON.stringify(envelope), { mode: 0o600 });
    await expect(
      loadBlueprintPlanReference({
        stateDirectory,
        planRef: reference,
        signingSecret: SIGNING_SECRET,
      }),
    ).rejects.toMatchObject({ code: 'PLAN_REFERENCE_TAMPERED' });

    const otherDirectory = temporaryDirectory();
    const otherReference = await save(otherDirectory);
    await expect(
      loadBlueprintPlanReference({
        stateDirectory: otherDirectory,
        planRef: otherReference,
        signingSecret: 'wrong-secret',
      }),
    ).rejects.toMatchObject({ code: 'PLAN_REFERENCE_TAMPERED' });

    const otherPath = referencePath(otherDirectory, otherReference);
    writeFileSync(otherPath, '{bad-json', { mode: 0o600 });
    await expect(
      loadBlueprintPlanReference({
        stateDirectory: otherDirectory,
        planRef: otherReference,
        signingSecret: SIGNING_SECRET,
      }),
    ).rejects.toMatchObject({ code: 'PLAN_REFERENCE_MALFORMED' });

    writeFileSync(otherPath, 'x'.repeat(1_048_577), { mode: 0o600 });
    await expect(
      loadBlueprintPlanReference({
        stateDirectory: otherDirectory,
        planRef: otherReference,
        signingSecret: SIGNING_SECRET,
      }),
    ).rejects.toMatchObject({ code: 'PLAN_REFERENCE_MALFORMED' });
  });

  it('rejects unknown and path-invalid references before deriving a storage path', async () => {
    const stateDirectory = temporaryDirectory();
    await expect(
      loadBlueprintPlanReference({
        stateDirectory,
        planRef: `dmbpr1.${'a'.repeat(64)}`,
        signingSecret: SIGNING_SECRET,
      }),
    ).rejects.toMatchObject({ code: 'PLAN_REFERENCE_NOT_FOUND' });
    await expect(
      loadBlueprintPlanReference({
        stateDirectory,
        planRef: '../escape',
        signingSecret: SIGNING_SECRET,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_REFERENCE' });
  });

  it('rejects an authenticated conflicting record without replacing it', async () => {
    const stateDirectory = temporaryDirectory();
    const first = payload();
    const reference = await save(stateDirectory, first);
    const second = { ...first, initial_snapshot_id: `sha256:${'4'.repeat(64)}` };
    const secondPlanId = encodeBlueprintPlan(second, SIGNING_SECRET).plan_id;
    const unsigned = {
      schema_version: 'guild_blueprint_plan_reference_envelope.v1',
      reference,
      plan_id: secondPlanId,
      payload: second,
    };
    const auth_tag = createHmac('sha256', SIGNING_SECRET)
      .update(`discord-mcp-blueprint-plan-reference-envelope.v1\0${canonicalJson(unsigned)}`)
      .digest('hex');
    writeFileSync(
      referencePath(stateDirectory, reference),
      JSON.stringify({ ...unsigned, auth_tag }),
      {
        mode: 0o600,
      },
    );

    await expect(save(stateDirectory, first)).rejects.toMatchObject({
      code: 'PLAN_REFERENCE_CONFLICT',
    });
  });

  it.runIf(process.platform !== 'win32')('fails closed for symlink records', async () => {
    const stateDirectory = temporaryDirectory();
    const reference = await save(stateDirectory);
    const path = referencePath(stateDirectory, reference);
    const replacement = join(stateDirectory, 'replacement.json');
    writeFileSync(replacement, readFileSync(path), { mode: 0o600 });
    unlinkSync(path);
    symlinkSync(replacement, path, 'file');
    expect(lstatSync(path).isSymbolicLink()).toBe(true);

    await expect(
      loadBlueprintPlanReference({
        stateDirectory,
        planRef: reference,
        signingSecret: SIGNING_SECRET,
      }),
    ).rejects.toMatchObject({ code: 'PLAN_REFERENCE_UNSAFE' });
  });

  it('does not accept a payload paired with a different plan id', async () => {
    const stateDirectory = temporaryDirectory();
    await expect(
      saveBlueprintPlanReference({
        stateDirectory,
        planId: `sha256:${'0'.repeat(64)}`,
        payload: payload(),
        signingSecret: SIGNING_SECRET,
      }),
    ).rejects.toBeInstanceOf(BlueprintPlanReferenceStoreError);
  });

  it('bounds retained references before writing another deterministic record', async () => {
    const stateDirectory = temporaryDirectory();
    const firstReference = await save(stateDirectory);
    const referenceDirectory = join(stateDirectory, 'plan-references-v1');
    const firstFilename = `${firstReference.slice('dmbpr1.'.length)}.json`;
    let created = 1;
    for (let index = 0; created < 256; index += 1) {
      const filename = `${index.toString(16).padStart(64, '0')}.json`;
      if (filename === firstFilename) continue;
      writeFileSync(join(referenceDirectory, filename), '{}\n', { mode: 0o600, flag: 'wx' });
      created += 1;
    }

    const second = { ...payload(), initial_snapshot_id: `sha256:${'9'.repeat(64)}` };
    await expect(
      saveBlueprintPlanReference({
        stateDirectory,
        planId: encodeBlueprintPlan(second, SIGNING_SECRET).plan_id,
        payload: second,
        signingSecret: SIGNING_SECRET,
      }),
    ).rejects.toMatchObject({ code: 'PLAN_REFERENCE_QUOTA' });
  });

  it('serializes concurrent callers at the exact record quota', async () => {
    const stateDirectory = temporaryDirectory();
    const firstReference = await save(stateDirectory);
    const referenceDirectory = join(stateDirectory, 'plan-references-v1');
    const firstFilename = `${firstReference.slice('dmbpr1.'.length)}.json`;
    let created = 1;
    for (let index = 0; created < 255; index += 1) {
      const filename = `${index.toString(16).padStart(64, '0')}.json`;
      if (filename === firstFilename) continue;
      writeFileSync(join(referenceDirectory, filename), '{}\n', { mode: 0o600, flag: 'wx' });
      created += 1;
    }

    const candidates = ['8', '9'].map((digit) => ({
      ...payload(),
      initial_snapshot_id: `sha256:${digit.repeat(64)}`,
    }));
    const results = await Promise.allSettled(
      candidates.map((candidate) =>
        saveBlueprintPlanReference({
          stateDirectory,
          planId: encodeBlueprintPlan(candidate, SIGNING_SECRET).plan_id,
          payload: candidate,
          signingSecret: SIGNING_SECRET,
        }),
      ),
    );

    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find(({ status }) => status === 'rejected');
    expect(rejected).toMatchObject({
      status: 'rejected',
      reason: { code: 'PLAN_REFERENCE_QUOTA' },
    });
    expect(
      readdirSync(referenceDirectory).filter((name) => /^[a-f0-9]{64}\.json$/.test(name)),
    ).toHaveLength(256);
  });
});
