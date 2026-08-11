import { createHmac } from 'node:crypto';
import { tryGetCtx } from '../../../als/context.js';
import type { Config } from '../../../config.js';

export type BlueprintTrustBoundary = 'stdio_profile' | 'http_access_token';

export function blueprintTrustBoundary(): BlueprintTrustBoundary {
  return tryGetCtx()?.transport === 'http' ? 'http_access_token' : 'stdio_profile';
}

/**
 * Bind authenticated plans/checkpoints to the deployment's caller boundary.
 * Local stdio already has process/profile isolation. HTTP additionally mixes
 * the bearer credential so a token from another deployment cannot be replayed
 * merely because both deployments happen to use the same Discord bot token.
 */
export function blueprintSigningSecret(
  config: Config,
  boundary: BlueprintTrustBoundary = blueprintTrustBoundary(),
): string {
  if (boundary === 'stdio_profile') return config.DISCORD_TOKEN;
  return createHmac('sha256', config.DISCORD_TOKEN)
    .update('discord-mcp-blueprint-http-caller.v1\0')
    .update(config.DISCORD_MCP_ACCESS_TOKEN ?? 'missing-http-access-token')
    .digest('hex');
}
