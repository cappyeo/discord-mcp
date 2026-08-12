import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { loadConfig } from '../config.js';
import { ValidationError } from '../errors/client.js';
import { blueprintPlanTargetMiddleware } from './blueprint-plan-target.js';
import { compose, type MiddlewareContext } from './compose.js';
import { defaultGuildMiddleware } from './default-guild.js';
import { validateMiddleware } from './validate.js';

const GUILD_ID = '111122223333444455';
const OTHER_GUILD_ID = '222233334444555566';
const BOT_ID = '999000999000999000';
const TOKEN = 'Bot target.middleware.test-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

const inputSchema = {
  guild_id: z
    .string()
    .regex(/^\d{17,20}$/)
    .optional(),
  expected_bot_id: z
    .string()
    .regex(/^\d{17,20}$/)
    .optional(),
  request: z.string().min(3),
};

function run(
  args: unknown,
  env: NodeJS.ProcessEnv,
  toolName = 'guild_blueprint_plan',
): Promise<unknown> {
  const config = loadConfig({ DISCORD_TOKEN: TOKEN, LOG_LEVEL: 'fatal', ...env });
  const ctx: MiddlewareContext<unknown> = {
    tool: { name: toolName, category: 'guild', idempotent: true },
    args,
    meta: new Map([['toolPiece', { inputSchema }]]),
  };
  return compose(
    [
      defaultGuildMiddleware(config.DISCORD_DEFAULT_GUILD_ID),
      blueprintPlanTargetMiddleware(config),
      validateMiddleware(),
    ],
    async (call) => call.args,
  )(ctx);
}

describe('blueprintPlanTargetMiddleware', () => {
  it('resolves the sole allowlisted guild and locked bot from the caller profile', async () => {
    await expect(
      run(
        { request: 'Build a gaming server' },
        { DISCORD_EXPECTED_BOT_ID: BOT_ID, ALLOWED_GUILDS: GUILD_ID },
      ),
    ).resolves.toEqual({
      guild_id: GUILD_ID,
      expected_bot_id: BOT_ID,
      request: 'Build a gaming server',
    });
  });

  it('fails closed when more than one allowlisted guild could be selected', async () => {
    const result = run(
      { request: 'Build a gaming server' },
      {
        DISCORD_EXPECTED_BOT_ID: BOT_ID,
        ALLOWED_GUILDS: `${GUILD_ID},${OTHER_GUILD_ID}`,
      },
    );
    await expect(result).rejects.toBeInstanceOf(ValidationError);
    await expect(result).rejects.toMatchObject({
      issues: [expect.objectContaining({ code: 'target_selection_required' })],
    });
  });

  it('uses an explicit configured default when several guilds are allowlisted', async () => {
    await expect(
      run(
        { request: 'Build a gaming server' },
        {
          DISCORD_EXPECTED_BOT_ID: BOT_ID,
          DISCORD_DEFAULT_GUILD_ID: OTHER_GUILD_ID,
          ALLOWED_GUILDS: `${GUILD_ID},${OTHER_GUILD_ID}`,
        },
      ),
    ).resolves.toMatchObject({ guild_id: OTHER_GUILD_ID, expected_bot_id: BOT_ID });
  });

  it('never overwrites explicit target values or changes another tool', async () => {
    await expect(
      run(
        {
          guild_id: OTHER_GUILD_ID,
          expected_bot_id: '888000888000888000',
          request: 'Build a gaming server',
        },
        { DISCORD_EXPECTED_BOT_ID: BOT_ID, ALLOWED_GUILDS: GUILD_ID },
      ),
    ).resolves.toMatchObject({
      guild_id: OTHER_GUILD_ID,
      expected_bot_id: '888000888000888000',
    });

    await expect(
      run(
        { request: 'Build a gaming server' },
        { DISCORD_EXPECTED_BOT_ID: BOT_ID, ALLOWED_GUILDS: GUILD_ID },
        'templates_recommend',
      ),
    ).resolves.toEqual({ request: 'Build a gaming server' });
  });
});
