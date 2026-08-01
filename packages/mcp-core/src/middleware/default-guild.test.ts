import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { compose, type MiddlewareContext } from './compose.js';
import { defaultGuildMiddleware } from './default-guild.js';
import { validateMiddleware } from './validate.js';

const DEFAULT_GUILD_ID = '111122223333444455';

function run(
  args: unknown,
  inputSchema: Record<string, z.ZodTypeAny>,
  defaultGuildId: string | undefined,
): Promise<unknown> {
  const ctx: MiddlewareContext<unknown> = {
    tool: { name: 'guild_get', category: 'guild', idempotent: true },
    args,
    meta: new Map([['toolPiece', { inputSchema }]]),
  };
  return compose(
    [defaultGuildMiddleware(defaultGuildId), validateMiddleware()],
    async (call) => call.args,
  )(ctx);
}

describe('defaultGuildMiddleware', () => {
  const guildToolSchema = {
    guild_id: z.string().regex(/^\d{17,20}$/),
    user_id: z.string().regex(/^\d{17,20}$/),
  };

  it('supplies an omitted guild_id before validation', async () => {
    await expect(
      run({ user_id: '999000999000999000' }, guildToolSchema, DEFAULT_GUILD_ID),
    ).resolves.toEqual({ guild_id: DEFAULT_GUILD_ID, user_id: '999000999000999000' });
  });

  it('never overwrites an explicit guild_id', async () => {
    await expect(
      run(
        { guild_id: '222233334444555566', user_id: '999000999000999000' },
        guildToolSchema,
        DEFAULT_GUILD_ID,
      ),
    ).resolves.toEqual({ guild_id: '222233334444555566', user_id: '999000999000999000' });
  });

  it('does not add guild_id to tools that do not declare it', async () => {
    await expect(
      run({ channel_id: '112233445566778899' }, { channel_id: z.string() }, DEFAULT_GUILD_ID),
    ).resolves.toEqual({
      channel_id: '112233445566778899',
    });
  });

  it('does nothing when no default is configured', async () => {
    await expect(
      run({ user_id: '999000999000999000' }, guildToolSchema, undefined),
    ).rejects.toThrow(/Input validation failed/);
  });
});
