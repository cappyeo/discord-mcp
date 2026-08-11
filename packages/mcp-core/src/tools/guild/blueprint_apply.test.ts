import { container } from '@sapphire/pieces';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../config.js';
import GuildBlueprintApply from './blueprint_apply.js';

function tool() {
  return new GuildBlueprintApply(
    { name: 'guild_blueprint_apply', path: 'inline', root: 'inline', store: null as never },
    { name: 'guild_blueprint_apply', enabled: true },
  );
}

describe('guild_blueprint_apply contract', () => {
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
    expect(JSON.stringify(result)).not.toContain(planToken);
  });
});
