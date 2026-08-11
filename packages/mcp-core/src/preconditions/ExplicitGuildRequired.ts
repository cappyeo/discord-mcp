import { ValidationError } from '../errors/client.js';
import type { MiddlewareContext } from '../middleware/compose.js';
import { Precondition } from '../pieces/Precondition.js';

function hasExplicitGuildId(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  if (!Object.hasOwn(value, 'guild_id')) return false;
  const guildId = (value as { guild_id?: unknown }).guild_id;
  return typeof guildId === 'string' && guildId.trim().length > 0;
}

/**
 * Prevent a target-sensitive tool from silently using the configured default guild.
 *
 * The raw payload is checked because defaultGuildMiddleware may have already
 * filled `ctx.args.guild_id` by the time preconditions run.
 */
export class ExplicitGuildRequired extends Precondition {
  public override readonly identifier = 'explicit_guild_required';

  public override async run(ctx: MiddlewareContext<unknown>): Promise<void> {
    const rawArgs = ctx.meta.get('rawArgs');
    if (hasExplicitGuildId(rawArgs)) return;

    throw new ValidationError([
      {
        path: 'guild_id',
        message: 'guild_id must be provided explicitly for this target-sensitive operation.',
        code: 'explicit_guild_required',
      },
    ]);
  }
}
