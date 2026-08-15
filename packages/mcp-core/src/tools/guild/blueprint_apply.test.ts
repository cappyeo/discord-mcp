import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RateLimitError, type REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { TaskCancelledError } from 'cockatiel';
import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../config.js';
import { BlueprintExecutionError } from './_lib/blueprint.apply-executor.js';
import GuildBlueprintApply, { safeApplyError } from './blueprint_apply.js';

function tool() {
  return new GuildBlueprintApply(
    { name: 'guild_blueprint_apply', path: 'inline', root: 'inline', store: null as never },
    { name: 'guild_blueprint_apply', enabled: true },
  );
}

describe('guild_blueprint_apply contract', () => {
  it('classifies an upstream Cockatiel timeout as a resumable apply failure', () => {
    expect(safeApplyError(new TaskCancelledError(), null)).toEqual({
      operation_id: null,
      code: 'UPSTREAM_TIMEOUT',
      retriable: true,
      status: null,
    });
    expect(safeApplyError(new TaskCancelledError(), 'op:channel:create')).toEqual({
      operation_id: 'op:channel:create',
      code: 'UPSTREAM_TIMEOUT',
      retriable: true,
      status: null,
    });
  });

  it('keeps exhausted publication channel propagation resumable on the same plan', () => {
    expect(
      safeApplyError(
        new BlueprintExecutionError('PUBLICATION_CHANNEL_NOT_READY', 'not ready', 404),
        'publication:welcome:ensure',
      ),
    ).toEqual({
      operation_id: 'publication:welcome:ensure',
      code: 'PUBLICATION_CHANNEL_NOT_READY',
      retriable: true,
      status: 404,
    });
  });

  it('preserves Discord Retry-After on a resumable rate-limit response', () => {
    const rateLimit = new RateLimitError({
      timeToReset: 240_000,
      limit: 5,
      method: 'POST',
      hash: 'guild-resource-create',
      url: 'https://discord.com/api/v10/guilds/100000000000000001/roles',
      route: '/guilds/:id/roles',
      majorParameter: '100000000000000001',
      global: false,
      retryAfter: 240_000,
      sublimitTimeout: 0,
      scope: 'user',
    });

    expect(safeApplyError(rateLimit, 'role:member:create')).toEqual({
      operation_id: 'role:member:create',
      code: 'DISCORD_RATE_LIMITED',
      retriable: true,
      status: 429,
      retry_after_ms: 240_000,
    });
  });

  it('declares both target and destructive safety gates', () => {
    const instance = tool();

    expect(instance.preconditions).toEqual(['explicit_guild_required', 'confirm_required']);
    expect(instance.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
    });
  });

  it('rejects an invalid plan token before Discord access and never echoes it', async () => {
    const planToken = 'dmbp1.invalid.payload';
    const previousConfig = container.config;
    container.config = loadConfig({ DISCORD_TOKEN: 'test.discord.token.'.padEnd(64, 'x') });
    let result: {
      readonly isError: boolean;
      readonly content: readonly { readonly type: string; readonly text?: string }[];
      readonly structuredContent: { readonly status: string; readonly blockers: unknown[] };
    };
    try {
      result = (await tool().run(
        {
          guild_id: '100000000000000001',
          expected_bot_id: '100000000000000002',
          plan_token: planToken,
          approval_id: `sha256:${'1'.repeat(64)}`,
          operation_budget: 25,
        },
        { signal: new AbortController().signal },
      )) as typeof result;
    } finally {
      container.config = previousConfig;
    }

    expect(result.isError).toBe(false);
    expect(result.structuredContent.status).toBe('blocked');
    expect(result.structuredContent.blockers).toEqual([
      expect.objectContaining({ code: 'PLAN_TOKEN_INVALID' }),
    ]);
    const text = result.content.find((block) => block.type === 'text')?.text ?? '';
    expect(text).toContain('MCP_BLUEPRINT_RECEIPT ');
    expect(text).toContain('"phase":"apply"');
    expect(text).toContain('"status":"blocked"');
    expect(JSON.stringify(result)).not.toContain(planToken);
  });

  it.each([
    ['missing both', {}],
    [
      'both references',
      {
        plan_ref: `dmbpr1.${'a'.repeat(64)}`,
        plan_token: 'legacy-token',
      },
    ],
  ])('enforces plan reference XOR before Discord access (%s)', async (_label, referenceArgs) => {
    const previousConfig = container.config;
    container.config = loadConfig({ DISCORD_TOKEN: 'test.discord.token.'.padEnd(64, 'x') });
    let result: {
      readonly isError: boolean;
      readonly structuredContent: { readonly status: string; readonly blockers: unknown[] };
    };
    try {
      result = (await tool().run(
        {
          guild_id: '100000000000000001',
          expected_bot_id: '100000000000000002',
          approval_id: `sha256:${'1'.repeat(64)}`,
          operation_budget: 25,
          ...referenceArgs,
        },
        { signal: new AbortController().signal },
      )) as typeof result;
    } finally {
      container.config = previousConfig;
    }
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toMatchObject({
      status: 'blocked',
      blockers: [expect.objectContaining({ code: 'PLAN_REFERENCE_XOR_REQUIRED' })],
    });
  });

  it('rejects invalid and unknown references before Discord access', async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), 'discord-mcp-apply-reference-'));
    try {
      const previousConfig = container.config;
      const previousRest = container.rest;
      const discordAccess = vi.fn(async () => {
        throw new Error('unexpected Discord access');
      });
      try {
        container.config = loadConfig({
          DISCORD_TOKEN: 'wrong.profile.secret.'.padEnd(64, 'y'),
          MCP_BLUEPRINT_STATE_DIR: stateDirectory,
        });
        container.rest = {
          get: discordAccess,
          post: discordAccess,
          put: discordAccess,
          patch: discordAccess,
          delete: discordAccess,
        } as unknown as REST;
        for (const planRef of ['dmbpr1.invalid', `dmbpr1.${'f'.repeat(64)}`] as const) {
          const result = (await tool().run(
            {
              guild_id: '100000000000000001',
              expected_bot_id: '100000000000000002',
              plan_ref: planRef,
              approval_id: `sha256:${'1'.repeat(64)}`,
              operation_budget: 25,
            },
            { signal: new AbortController().signal },
          )) as { readonly isError: boolean; readonly structuredContent: { blockers: unknown[] } };
          expect(result.isError).toBe(false);
          expect(result.structuredContent.blockers).toEqual([
            expect.objectContaining({ code: 'PLAN_REFERENCE_INVALID' }),
          ]);
        }
        expect(discordAccess).not.toHaveBeenCalled();
      } finally {
        container.config = previousConfig;
        container.rest = previousRest;
      }
    } finally {
      await rm(stateDirectory, { recursive: true, force: true });
    }
  });
});
