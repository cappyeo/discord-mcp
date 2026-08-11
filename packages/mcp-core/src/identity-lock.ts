import type { REST } from '@discordjs/rest';
import { Routes } from 'discord-api-types/v10';

export interface DiscordBotIdentity {
  readonly id: string;
  readonly username: string | null;
}

interface RawDiscordUser {
  readonly id?: unknown;
  readonly username?: unknown;
  readonly bot?: unknown;
}

const verifiedByRest = new WeakMap<REST, Map<string, DiscordBotIdentity>>();

async function fetchExpectedBotIdentity(
  rest: REST,
  expectedBotId: string,
  signal?: AbortSignal,
): Promise<DiscordBotIdentity> {
  const raw = (await rest.get(Routes.user('@me'), { signal })) as RawDiscordUser;
  if (typeof raw.id !== 'string' || raw.bot !== true) {
    throw new Error('Discord identity verification did not return a bot account');
  }
  if (raw.id !== expectedBotId) {
    throw new Error(`Discord bot identity mismatch: expected ${expectedBotId}, received ${raw.id}`);
  }
  return {
    id: raw.id,
    username: typeof raw.username === 'string' ? raw.username : null,
  };
}

/**
 * Verify that the configured token still belongs to the caller-selected bot.
 * Successful checks are cached per REST instance so stateless HTTP MCP
 * requests do not repeat `/users/@me`. In-flight and rejected checks are not
 * shared so one caller's cancellation cannot affect another caller or poison
 * a long-lived embedding.
 */
export function verifyExpectedBotIdentity(
  rest: REST,
  expectedBotId: string | undefined,
  signal?: AbortSignal,
): Promise<DiscordBotIdentity | null> {
  if (expectedBotId === undefined) return Promise.resolve(null);

  let byExpectedId = verifiedByRest.get(rest);
  if (byExpectedId === undefined) {
    byExpectedId = new Map();
    verifiedByRest.set(rest, byExpectedId);
  }

  const cached = byExpectedId.get(expectedBotId);
  if (cached !== undefined) return Promise.resolve(cached);

  return fetchExpectedBotIdentity(rest, expectedBotId, signal).then((identity) => {
    byExpectedId.set(expectedBotId, identity);
    return identity;
  });
}
