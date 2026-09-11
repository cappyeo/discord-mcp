import type { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../config.js';
import { BlueprintCheckpointStore } from './_lib/blueprint.checkpoint-store.js';
import { emptyBlueprintBindings } from './_lib/blueprint.execution.schema.js';
import { blueprintFingerprint, compileGuildBlueprint } from './_lib/blueprint.js';
import { encodeBlueprintPlan } from './_lib/blueprint.plan-token.js';
import { readBlueprintTargetSnapshot } from './_lib/blueprint.target.js';
import GuildBlueprintApply from './blueprint_apply.js';

vi.mock('./_lib/blueprint.target.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./_lib/blueprint.target.js')>()),
  readBlueprintTargetSnapshot: vi.fn(),
}));

const guildId = '100000000000000001';
const botId = '100000000000000002';
const secret = 'test.discord.token.'.padEnd(64, 'x');
const blueprint = compileGuildBlueprint({
  request: 'Gaming community',
  requested_capabilities: ['gaming'],
  inspirations: [],
  primary: {
    code: 'primary',
    effective_capabilities: ['gaming'],
    blueprint: {
      channel_count: 10,
      category_count: 2,
      text_channel_count: 6,
      voice_channel_count: 2,
      forum_channel_count: 0,
      stage_channel_count: 0,
      other_channel_count: 0,
      nsfw_channel_count: 0,
      permission_overwrite_count: 0,
      role_count: 4,
      privileged_role_count: 0,
      risky_permission_signals: [],
    },
  },
});
const encoded = encodeBlueprintPlan(
  {
    schema_version: 'guild_blueprint_plan.v1',
    policy_version: 'safe-reconcile.v1',
    target: { guild_id: guildId, bot_id: botId },
    blueprint,
    blueprint_id: blueprintFingerprint(blueprint),
    initial_snapshot_id: `sha256:${'1'.repeat(64)}`,
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
  },
  secret,
);

function run() {
  const tool = new GuildBlueprintApply(
    { name: 'guild_blueprint_apply', path: 'inline', root: 'inline', store: null as never },
    { name: 'guild_blueprint_apply', enabled: true },
  );
  return tool.run(
    {
      guild_id: guildId,
      expected_bot_id: botId,
      plan_token: encoded.plan_token,
      approval_id: encoded.approval_id,
      operation_budget: 25,
    },
    { signal: new AbortController().signal },
  );
}

const previousConfig = container.config;
const previousRest = container.rest;

beforeEach(() => {
  container.config = loadConfig({
    DISCORD_TOKEN: secret,
    DISCORD_EXPECTED_BOT_ID: botId,
    ALLOWED_GUILDS: guildId,
  });
  container.rest = {
    get: vi.fn().mockResolvedValue({ id: botId, bot: true }),
    post: vi.fn(),
  } as unknown as REST;
  vi.spyOn(BlueprintCheckpointStore.prototype, 'load').mockResolvedValue(null);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  container.config = previousConfig;
  container.rest = previousRest;
});

describe('blueprint apply lock failures', () => {
  it.each([
    'busy',
    'failure',
  ] as const)('releases the guild lock when the plan lock reports %s', async (mode) => {
    const release = vi.fn().mockRejectedValue(new Error('Release failed'));
    const acquire = vi
      .spyOn(BlueprintCheckpointStore.prototype, 'tryAcquireLock')
      .mockResolvedValueOnce({ acquired: true, release, heartbeat: vi.fn() });
    if (mode === 'busy')
      acquire.mockResolvedValueOnce({ acquired: false, release: vi.fn(), heartbeat: vi.fn() });
    else acquire.mockRejectedValueOnce(new Error('Lock failed'));
    const result = await run();
    expect(result.structuredContent).toMatchObject({
      status: mode === 'busy' ? 'busy' : 'blocked',
      attempts: [],
    });
    expect(release).toHaveBeenCalledOnce();
    expect(container.rest.post).not.toHaveBeenCalled();
  });

  it.each([
    'lost',
    'failure',
  ] as const)('aborts snapshot reads when a lock heartbeat is %s', async (mode) => {
    vi.useFakeTimers();
    const targetRelease = vi.fn().mockRejectedValue(new Error('Target release failed'));
    const planRelease = vi.fn().mockRejectedValue(new Error('Plan release failed'));
    const targetHeartbeat = vi.fn().mockResolvedValue(true);
    const planHeartbeat = vi.fn().mockResolvedValueOnce(true);
    if (mode === 'lost') planHeartbeat.mockResolvedValueOnce(false);
    else planHeartbeat.mockRejectedValueOnce(new Error('Heartbeat failed'));
    vi.spyOn(BlueprintCheckpointStore.prototype, 'tryAcquireLock')
      .mockResolvedValueOnce({ acquired: true, release: targetRelease, heartbeat: targetHeartbeat })
      .mockResolvedValueOnce({ acquired: true, release: planRelease, heartbeat: planHeartbeat });
    let applySignal: AbortSignal | undefined;
    vi.mocked(readBlueprintTargetSnapshot).mockImplementationOnce(async (...args) => {
      applySignal = args[5];
      return new Promise((_resolve, reject) => {
        applySignal!.addEventListener(
          'abort',
          () => reject(new DOMException('Aborted', 'AbortError')),
          { once: true },
        );
      });
    });
    const execution = run();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(applySignal?.aborted).toBe(false);
    expect(planHeartbeat).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(30_000);
    const result = await execution;
    expect(applySignal?.aborted).toBe(true);
    expect(result.structuredContent).toMatchObject({
      status: 'blocked',
      attempts: [],
      error: { code: 'CANCELLED' },
    });
    expect(targetRelease).toHaveBeenCalledOnce();
    expect(planRelease).toHaveBeenCalledOnce();
    expect(container.rest.post).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
