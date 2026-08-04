import type { REST } from '@discordjs/rest';
import { Routes } from 'discord-api-types/v10';

interface GuildChannel {
  readonly guild_id?: string;
}

const MAX_CHANNEL_GUILD_CACHE_ENTRIES = 1_024;
const channelGuildsByRest = new WeakMap<REST, Map<string, Promise<string | undefined>>>();

function cacheFor(rest: REST): Map<string, Promise<string | undefined>> {
  let cache = channelGuildsByRest.get(rest);
  if (cache === undefined) {
    cache = new Map();
    channelGuildsByRest.set(rest, cache);
  }
  return cache;
}

/**
 * Resolve a channel's guild once per REST client. Channel IDs never move
 * between guilds, so the successful result is safe to share between the
 * allowlist boundary and response helpers that need canonical jump links.
 */
export function resolveChannelGuildId(rest: REST, channelId: string): Promise<string | undefined> {
  const cache = cacheFor(rest);
  const existing = cache.get(channelId);
  if (existing !== undefined) return existing;

  if (cache.size >= MAX_CHANNEL_GUILD_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }

  const pending = (rest.get(Routes.channel(channelId)) as Promise<GuildChannel>)
    .then((channel) => channel.guild_id)
    .catch((error: unknown) => {
      cache.delete(channelId);
      throw error;
    });
  cache.set(channelId, pending);
  return pending;
}
