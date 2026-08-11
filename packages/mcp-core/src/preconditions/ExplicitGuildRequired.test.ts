import { describe, expect, it } from 'vitest';
import { ValidationError } from '../errors/client.js';
import type { MiddlewareContext } from '../middleware/compose.js';
import { ExplicitGuildRequired } from './ExplicitGuildRequired.js';

const piece = (): ExplicitGuildRequired =>
  new ExplicitGuildRequired(
    { name: 'explicit_guild_required', path: 'inline', root: 'inline', store: null as never },
    { name: 'explicit_guild_required', enabled: true },
  );

const ctx = (rawArgs: unknown): MiddlewareContext<unknown> => ({
  tool: { name: 'architect_apply', category: 'guild', idempotent: false },
  args: { guild_id: '1533478783867420712' },
  meta: new Map([['rawArgs', rawArgs]]),
});

describe('ExplicitGuildRequired', () => {
  it('passes when rawArgs owns a non-empty guild_id string', async () => {
    await expect(piece().run(ctx({ guild_id: '1533478783867420712' }))).resolves.toBeUndefined();
  });

  it.each([
    undefined,
    null,
    {},
    { guild_id: '' },
    { guild_id: '   ' },
    { guild_id: 1_533_478_783_867_420_700 },
    Object.create({ guild_id: '1533478783867420712' }),
  ])('rejects missing or non-explicit guild_id: %j', async (rawArgs) => {
    await expect(piece().run(ctx(rawArgs))).rejects.toBeInstanceOf(ValidationError);
  });

  it('checks rawArgs rather than a defaulted ctx.args guild_id', async () => {
    try {
      await piece().run(ctx({}));
      throw new Error('expected validation error');
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).issues).toEqual([
        {
          path: 'guild_id',
          message: 'guild_id must be provided explicitly for this target-sensitive operation.',
          code: 'explicit_guild_required',
        },
      ]);
    }
  });
});
