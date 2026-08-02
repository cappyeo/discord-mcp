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

const verifiedByRest = new WeakMap<REST, Map<string, Promise<DiscordBotIdentity>>>();

async function fetchExpectedBotIdentity(
  rest: REST,
  expectedBotId: string,
): Promise<DiscordBotIdentity> {
  const raw = (await rest.get(Routes.user('@me'))) as RawDiscordUser;
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
 * requests do not repeat `/users/@me`. Rejected checks are removed, allowing
 * an operator to correct a transient failure in a long-lived embedding.
 */
export function verifyExpectedBotIdentity(
  rest: REST,
  expectedBotId: string | undefined,
): Promise<DiscordBotIdentity | null> {
  if (expectedBotId === undefined) return Promise.resolve(null);

  let byExpectedId = verifiedByRest.get(rest);
  if (byExpectedId === undefined) {
    byExpectedId = new Map();
    verifiedByRest.set(rest, byExpectedId);
  }

  const cached = byExpectedId.get(expectedBotId);
  if (cached !== undefined) return cached;

  const pending = fetchExpectedBotIdentity(rest, expectedBotId);
  byExpectedId.set(expectedBotId, pending);
  void pending.catch(() => {
    if (byExpectedId?.get(expectedBotId) === pending) byExpectedId.delete(expectedBotId);
  });
  return pending;
}
