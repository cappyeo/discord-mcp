import type { Config } from '../config.js';
import { ValidationError } from '../errors/client.js';
import type { ToolMiddleware } from './compose.js';
import { parseGuildAllowlist } from './guild-allowlist.js';

const BLUEPRINT_PLAN_TOOL = 'guild_blueprint_plan';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export interface ResolvedBlueprintPlanTarget {
  readonly guild_id: string | undefined;
  readonly expected_bot_id: string | undefined;
  readonly guild_selection_required: boolean;
}

export function resolveBlueprintPlanTarget(
  config: Config,
  requestedGuildId: string | undefined,
  requestedBotId: string | undefined,
): ResolvedBlueprintPlanTarget {
  const allowedGuilds = parseGuildAllowlist(config.ALLOWED_GUILDS);
  const soleAllowedGuild =
    allowedGuilds !== null && allowedGuilds.size === 1
      ? allowedGuilds.values().next().value
      : undefined;
  return {
    guild_id: requestedGuildId ?? config.DISCORD_DEFAULT_GUILD_ID ?? soleAllowedGuild,
    expected_bot_id: requestedBotId ?? config.DISCORD_EXPECTED_BOT_ID,
    guild_selection_required:
      requestedGuildId === undefined &&
      config.DISCORD_DEFAULT_GUILD_ID === undefined &&
      allowedGuilds !== null &&
      allowedGuilds.size > 1,
  };
}

/**
 * Resolves the read-only architect entrypoint from the selected caller profile.
 * Explicit caller values always win. A guild is inferred only when the profile
 * has exactly one allowlisted target; ambiguity fails before Discord access.
 */
export function blueprintPlanTargetMiddleware(config: Config): ToolMiddleware {
  return {
    async onCallTool(ctx, next) {
      if (ctx.tool.name !== BLUEPRINT_PLAN_TOOL || !isRecord(ctx.args)) return next();

      const resolved: Record<string, unknown> = { ...ctx.args };
      const selection = resolveBlueprintPlanTarget(
        config,
        Object.hasOwn(resolved, 'guild_id') ? (resolved.guild_id as string) : undefined,
        Object.hasOwn(resolved, 'expected_bot_id')
          ? (resolved.expected_bot_id as string)
          : undefined,
      );
      if (!Object.hasOwn(resolved, 'guild_id')) {
        if (selection.guild_selection_required) {
          throw new ValidationError([
            {
              path: 'guild_id',
              message:
                'The selected caller profile allows multiple guilds; choose one explicit guild_id.',
              code: 'target_selection_required',
            },
          ]);
        }
        if (selection.guild_id !== undefined) resolved.guild_id = selection.guild_id;
      }
      if (!Object.hasOwn(resolved, 'expected_bot_id') && selection.expected_bot_id !== undefined) {
        resolved.expected_bot_id = selection.expected_bot_id;
      }

      (ctx as { args: unknown }).args = resolved;
      return next();
    },
  };
}
