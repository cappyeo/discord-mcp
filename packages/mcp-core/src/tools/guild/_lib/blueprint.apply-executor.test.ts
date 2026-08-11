import { RateLimitError, type REST } from '@discordjs/rest';
import { describe, expect, it, vi } from 'vitest';
import { executeBlueprintOperation } from './blueprint.apply-executor.js';
import {
  type BlueprintOperation,
  emptyBlueprintBindings,
  type GuildBlueprintPlanPayload,
} from './blueprint.execution.schema.js';
import { blueprintFingerprint, compileGuildBlueprint } from './blueprint.js';
import type { BlueprintTargetSnapshot } from './blueprint.target.js';

const GUILD_ID = '100000000000000001';
const BOT_ID = '100000000000000002';

const blueprint = compileGuildBlueprint({
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
});

const plan: GuildBlueprintPlanPayload = {
  schema_version: 'guild_blueprint_plan.v1',
  policy_version: 'safe-reconcile.v1',
  target: { guild_id: GUILD_ID, bot_id: BOT_ID },
  blueprint_id: blueprintFingerprint(blueprint),
  blueprint,
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
};

function bindings() {
  const result = emptyBlueprintBindings();
  blueprint.roles.forEach((role, index) => {
    result.roles[role.key] = String(200_000_000_000_000_000n + BigInt(index));
  });
  blueprint.categories.forEach((category, index) => {
    result.categories[category.key] = String(210_000_000_000_000_000n + BigInt(index));
  });
  blueprint.channels.forEach((channel, index) => {
    result.channels[channel.key] = String(220_000_000_000_000_000n + BigInt(index));
  });
  return result;
}

function operation(
  resource: BlueprintOperation['resource'],
  action: BlueprintOperation['action'],
  key: string,
): BlueprintOperation {
  return {
    operation_id: `${resource}:${action}:${key}`,
    phase:
      resource === 'role_order'
        ? 'ordering'
        : resource === 'welcome_screen'
          ? 'welcome'
          : 'categories',
    action,
    resource,
    key,
    summary: 'Security response validation test.',
    risk: 'medium',
  };
}

const snapshot = {
  bot: { user: { id: BOT_ID }, roles: ['100000000000000010'] },
  roles: [
    {
      id: '100000000000000010',
      name: 'Bot',
      color: 0,
      position: 100,
      permissions: '8',
      mentionable: false,
      hoist: false,
      managed: false,
    },
  ],
} as unknown as BlueprintTargetSnapshot;
const signal = new AbortController().signal;

describe('blueprint operation response validation', () => {
  it('forwards the apply signal to the role create request', async () => {
    const controller = new AbortController();
    const role = blueprint.roles[0]!;
    const currentBindings = bindings();
    delete currentBindings.roles[role.key];
    const post = vi.fn(async () => ({ id: '230000000000000000' }));

    await expect(
      executeBlueprintOperation({
        rest: { post } as unknown as REST,
        plan,
        operation: operation('role', 'create', role.key),
        bindings: currentBindings,
        snapshot,
        signal: controller.signal,
      }),
    ).resolves.toEqual({ resource_id: '230000000000000000' });

    expect(post).toHaveBeenCalledOnce();
    expect(post.mock.calls[0]![1]).toMatchObject({ signal: controller.signal });
  });

  it('rejects a guild-scoped create response that omits the target guild identity', async () => {
    const rest = {
      post: async () => ({ id: '230000000000000000' }),
    } as unknown as REST;

    await expect(
      executeBlueprintOperation({
        rest,
        plan,
        operation: operation('category', 'create', blueprint.categories[0]!.key),
        bindings: bindings(),
        snapshot,
        signal,
      }),
    ).rejects.toMatchObject({ code: 'TARGET_GUILD_MISMATCH' });
  });

  it('rejects a role-order response that omits a managed role', async () => {
    const rest = { patch: async () => [] } as unknown as REST;

    await expect(
      executeBlueprintOperation({
        rest,
        plan,
        operation: operation('role_order', 'reorder', 'generated_roles'),
        bindings: bindings(),
        snapshot,
        signal,
      }),
    ).rejects.toMatchObject({ code: 'DISCORD_RESPONSE_INVALID' });
  });

  it('performs zero REST calls when the proposed order reaches the bot role', async () => {
    const patch = vi.fn(async () => []);
    const unsafeSnapshot = {
      ...snapshot,
      roles: [{ ...snapshot.roles[0]!, position: 2 }],
    } as BlueprintTargetSnapshot;

    await expect(
      executeBlueprintOperation({
        rest: { patch } as unknown as REST,
        plan,
        operation: operation('role_order', 'reorder', 'generated_roles'),
        bindings: bindings(),
        snapshot: unsafeSnapshot,
        signal,
      }),
    ).rejects.toMatchObject({ code: 'BOT_ROLE_HIERARCHY' });
    expect(patch).not.toHaveBeenCalled();
  });

  it('preserves a safe role reorder and validates every returned role', async () => {
    const patch = vi.fn(async () => Object.values(bindings().roles).map((id) => ({ id })));

    await expect(
      executeBlueprintOperation({
        rest: { patch } as unknown as REST,
        plan,
        operation: operation('role_order', 'reorder', 'generated_roles'),
        bindings: bindings(),
        snapshot,
        signal,
      }),
    ).resolves.toEqual({ resource_id: null });
    expect(patch).toHaveBeenCalledOnce();
  });

  it('reorders channels without batching multiple parent moves', async () => {
    const patch = vi.fn(async () => undefined);

    await expect(
      executeBlueprintOperation({
        rest: { patch } as unknown as REST,
        plan,
        operation: operation('channel_order', 'reorder', 'managed_channels'),
        bindings: bindings(),
        snapshot,
        signal,
      }),
    ).resolves.toEqual({ resource_id: null });
    expect(patch).toHaveBeenCalledOnce();
    const options = patch.mock.calls[0]![1] as { body: Array<Record<string, unknown>> };
    expect(options.body).toHaveLength(blueprint.categories.length + blueprint.channels.length);
    expect(options.body.every((item) => !Object.hasOwn(item, 'parent_id'))).toBe(true);
  });

  it('binds a publication response with optional guild_id through channel readback', async () => {
    const currentBindings = bindings();
    const publication = blueprint.components_v2.publications[0]!;
    const channelId = currentBindings.channels[publication.channel_key]!;
    const messageId = '230000000000000000';
    const get = vi.fn(async () => ({ id: channelId, guild_id: GUILD_ID }));
    const post = vi.fn(async () => ({
      id: messageId,
      channel_id: channelId,
      author: { id: BOT_ID },
    }));

    await expect(
      executeBlueprintOperation({
        rest: { get, post } as unknown as REST,
        plan,
        operation: operation('publication', 'send', publication.key),
        bindings: currentBindings,
        snapshot,
        signal,
      }),
    ).resolves.toEqual({ resource_id: messageId });
    expect(get).toHaveBeenCalledOnce();
    expect(currentBindings.publications[publication.key]).toBe(messageId);
  });

  it('distinguishes a publication channel readback failure from the message write', async () => {
    const currentBindings = bindings();
    const publication = blueprint.components_v2.publications[0]!;
    const channelId = currentBindings.channels[publication.channel_key]!;

    await expect(
      executeBlueprintOperation({
        rest: {
          get: async () => {
            throw Object.assign(new Error('Forbidden'), { status: 403 });
          },
          post: async () => ({
            id: '230000000000000000',
            channel_id: channelId,
            author: { id: BOT_ID },
          }),
        } as unknown as REST,
        plan,
        operation: operation('publication', 'send', publication.key),
        bindings: currentBindings,
        snapshot,
        signal,
      }),
    ).rejects.toMatchObject({ code: 'PUBLICATION_CHANNEL_READBACK_FAILED' });
  });

  it('retries a transient publication channel readback without reposting the message', async () => {
    const currentBindings = bindings();
    const publication = blueprint.components_v2.publications[0]!;
    const channelId = currentBindings.channels[publication.channel_key]!;
    const messageId = '230000000000000001';
    const get = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('Unknown Channel'), { status: 404 }))
      .mockResolvedValueOnce({ id: channelId, guild_id: GUILD_ID });
    const post = vi.fn(async () => ({
      id: messageId,
      channel_id: channelId,
      author: { id: BOT_ID },
    }));

    await expect(
      executeBlueprintOperation({
        rest: { get, post } as unknown as REST,
        plan,
        operation: operation('publication', 'send', publication.key),
        bindings: currentBindings,
        snapshot,
        signal,
      }),
    ).resolves.toEqual({ resource_id: messageId });
    expect(post).toHaveBeenCalledOnce();
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('retries a REST rate limit during publication channel readback', async () => {
    const currentBindings = bindings();
    const publication = blueprint.components_v2.publications[0]!;
    const channelId = currentBindings.channels[publication.channel_key]!;
    const messageId = '230000000000000002';
    const rateLimit = new RateLimitError({
      timeToReset: 1_000,
      limit: 5,
      method: 'GET',
      hash: 'publication-readback',
      url: `https://discord.com/api/v10/channels/${channelId}`,
      route: '/channels/:id',
      majorParameter: channelId,
      global: false,
      retryAfter: 1_000,
      sublimitTimeout: 0,
      scope: 'user',
    });
    const get = vi
      .fn()
      .mockRejectedValueOnce(rateLimit)
      .mockResolvedValueOnce({ id: channelId, guild_id: GUILD_ID });
    const post = vi.fn(async () => ({
      id: messageId,
      channel_id: channelId,
      author: { id: BOT_ID },
    }));

    vi.useFakeTimers();
    try {
      const execution = executeBlueprintOperation({
        rest: { get, post } as unknown as REST,
        plan,
        operation: operation('publication', 'send', publication.key),
        bindings: currentBindings,
        snapshot,
        signal,
      });
      await vi.advanceTimersByTimeAsync(999);
      expect(get).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1);
      await expect(execution).resolves.toEqual({ resource_id: messageId });
      expect(post).toHaveBeenCalledOnce();
      expect(get).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('surfaces a long publication readback rate limit without retrying early', async () => {
    const currentBindings = bindings();
    const publication = blueprint.components_v2.publications[0]!;
    const channelId = currentBindings.channels[publication.channel_key]!;
    const rateLimit = new RateLimitError({
      timeToReset: 240_000,
      limit: 5,
      method: 'GET',
      hash: 'publication-readback',
      url: `https://discord.com/api/v10/channels/${channelId}`,
      route: '/channels/:id',
      majorParameter: channelId,
      global: false,
      retryAfter: 240_000,
      sublimitTimeout: 0,
      scope: 'user',
    });
    const get = vi.fn(async () => {
      throw rateLimit;
    });
    const post = vi.fn(async () => ({
      id: '230000000000000003',
      channel_id: channelId,
      author: { id: BOT_ID },
    }));

    await expect(
      executeBlueprintOperation({
        rest: { get, post } as unknown as REST,
        plan,
        operation: operation('publication', 'send', publication.key),
        bindings: currentBindings,
        snapshot,
        signal,
      }),
    ).rejects.toBe(rateLimit);
    expect(get).toHaveBeenCalledOnce();
    expect(post).toHaveBeenCalledOnce();
  });

  it('cancels an in-flight publication channel readback without retrying', async () => {
    const currentBindings = bindings();
    const publication = blueprint.components_v2.publications[0]!;
    const channelId = currentBindings.channels[publication.channel_key]!;
    const controller = new AbortController();
    const get = vi.fn(async (_route: string, options: { signal?: AbortSignal }) => {
      expect(options.signal).toBe(controller.signal);
      controller.abort();
      throw new DOMException('Aborted', 'AbortError');
    });

    await expect(
      executeBlueprintOperation({
        rest: {
          get,
          post: async () => ({
            id: '230000000000000003',
            channel_id: channelId,
            author: { id: BOT_ID },
          }),
        } as unknown as REST,
        plan,
        operation: operation('publication', 'send', publication.key),
        bindings: currentBindings,
        snapshot,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(get).toHaveBeenCalledOnce();
  });

  it('retries a publication 404 with the same nonce-bearing body', async () => {
    const currentBindings = bindings();
    const publication = blueprint.components_v2.publications[0]!;
    const channelId = currentBindings.channels[publication.channel_key]!;
    const messageId = '230000000000000001';
    const post = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('Unknown Channel'), { status: 404 }))
      .mockResolvedValueOnce({
        id: messageId,
        channel_id: channelId,
        author: { id: BOT_ID },
      });

    await expect(
      executeBlueprintOperation({
        rest: { post, get: async () => ({ id: channelId, guild_id: GUILD_ID }) } as unknown as REST,
        plan,
        operation: operation('publication', 'send', publication.key),
        bindings: currentBindings,
        snapshot,
        signal,
      }),
    ).resolves.toEqual({ resource_id: messageId });
    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls[0]![0]).toBe(post.mock.calls[1]![0]);
    expect(post.mock.calls[0]![1]).toEqual(post.mock.calls[1]![1]);
    expect((post.mock.calls[0]![1] as { body: Record<string, unknown> }).body.nonce).toEqual(
      expect.stringMatching(/^dmc[a-f0-9]{22}$/),
    );
    expect((post.mock.calls[0]![1] as { body: Record<string, unknown> }).body.enforce_nonce).toBe(
      true,
    );
  });

  it('bounds publication 404 retries and returns a resumable channel-readiness error', async () => {
    const currentBindings = bindings();
    const publication = blueprint.components_v2.publications[0]!;
    const post = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('Unknown Channel'), { status: 404 }));

    await expect(
      executeBlueprintOperation({
        rest: { post } as unknown as REST,
        plan,
        operation: operation('publication', 'send', publication.key),
        bindings: currentBindings,
        snapshot,
        signal,
      }),
    ).rejects.toMatchObject({ code: 'PUBLICATION_CHANNEL_NOT_READY', status: 404 });
    expect(post).toHaveBeenCalledTimes(4);
    expect(post.mock.calls[0]![1]).toEqual(post.mock.calls[1]![1]);
    expect(post.mock.calls[1]![1]).toEqual(post.mock.calls[2]![1]);
    expect(post.mock.calls[2]![1]).toEqual(post.mock.calls[3]![1]);
  });

  it('does not retry a non-404 publication error', async () => {
    const currentBindings = bindings();
    const publication = blueprint.components_v2.publications[0]!;
    const post = vi.fn().mockRejectedValue(Object.assign(new Error('Forbidden'), { status: 403 }));

    await expect(
      executeBlueprintOperation({
        rest: { post } as unknown as REST,
        plan,
        operation: operation('publication', 'send', publication.key),
        bindings: currentBindings,
        snapshot,
        signal,
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(post).toHaveBeenCalledOnce();
  });

  it('stops publication retries when the apply signal is cancelled', async () => {
    const currentBindings = bindings();
    const publication = blueprint.components_v2.publications[0]!;
    const controller = new AbortController();
    const post = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('Unknown Channel'), { status: 404 }));

    const pending = executeBlueprintOperation({
      rest: { post } as unknown as REST,
      plan,
      operation: operation('publication', 'send', publication.key),
      bindings: currentBindings,
      snapshot,
      signal: controller.signal,
    });
    controller.abort();

    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(post).toHaveBeenCalledOnce();
  });

  it('cancels an in-flight publication POST without retrying', async () => {
    const currentBindings = bindings();
    const publication = blueprint.components_v2.publications[0]!;
    const controller = new AbortController();
    const post = vi.fn(
      async (_route: string, options: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          expect(options.signal).toBe(controller.signal);
          options.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true },
          );
        }),
    );

    const pending = executeBlueprintOperation({
      rest: { post } as unknown as REST,
      plan,
      operation: operation('publication', 'send', publication.key),
      bindings: currentBindings,
      snapshot,
      signal: controller.signal,
    });
    controller.abort();

    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(post).toHaveBeenCalledOnce();
  });

  it('rejects a Welcome Screen response that differs from the approved payload', async () => {
    const rest = {
      patch: async () => ({ description: 'Wrong response', welcome_channels: [] }),
    } as unknown as REST;

    await expect(
      executeBlueprintOperation({
        rest,
        plan,
        operation: operation('welcome_screen', 'update', 'main'),
        bindings: bindings(),
        snapshot,
        signal,
      }),
    ).rejects.toMatchObject({ code: 'WELCOME_READBACK_MISMATCH' });
  });
});
