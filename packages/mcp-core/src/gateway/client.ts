import { bindAuditLogPollHandler } from './handlers/audit_log_poll.js';
import { bindGuildUpdateHandler } from './handlers/guild_update.js';
import { bindPresenceUpdateHandler } from './handlers/presence_update.js';
import { bindTypingStartHandler } from './handlers/typing_start.js';
import { bindVoiceStateUpdateHandler } from './handlers/voice_state_update.js';
import type { SubscriptionRegistry } from './subscription_registry.js';

interface MinimalDiscordClient {
  on: (event: string, listener: (...args: unknown[]) => void) => unknown;
  off: (event: string, listener: (...args: unknown[]) => void) => unknown;
  emit?: (event: string, ...args: unknown[]) => boolean;
  login: (token: string) => Promise<void>;
  destroy: () => Promise<void>;
  rest: { get: (path: string) => Promise<unknown> };
}

export interface GatewayClientDeps {
  token: string;
  registry: SubscriptionRegistry;
  notifyResource: (uri: string) => Promise<void> | void;
  /** Optional factory for testing — production lazy-imports discord.js. */
  clientFactory?: () => MinimalDiscordClient;
}

export interface GatewayClient {
  start(): Promise<void>;
  stop(): Promise<void>;
}

async function defaultClientFactory(): Promise<MinimalDiscordClient> {
  const dj = await import('discord.js');
  const Client = (dj as unknown as { Client: new (opts: unknown) => MinimalDiscordClient }).Client;
  const intents = (
    dj as unknown as {
      GatewayIntentBits: { Guilds: number; GuildVoiceStates: number; GuildPresences: number };
    }
  ).GatewayIntentBits;
  return new Client({
    intents: [intents.Guilds, intents.GuildVoiceStates, intents.GuildPresences],
  });
}

export function createGatewayClient(deps: GatewayClientDeps): GatewayClient {
  let client: MinimalDiscordClient | null = null;
  const teardowns: Array<() => void> = [];

  return {
    async start() {
      client =
        deps.clientFactory !== undefined ? deps.clientFactory() : await defaultClientFactory();
      try {
        const handlerDeps = {
          client: client as never,
          registry: deps.registry,
          notifyResource: deps.notifyResource,
        };
        teardowns.push(bindGuildUpdateHandler(handlerDeps));
        teardowns.push(bindVoiceStateUpdateHandler(handlerDeps));
        teardowns.push(bindTypingStartHandler(handlerDeps));
        teardowns.push(bindPresenceUpdateHandler(handlerDeps));
        teardowns.push(
          bindAuditLogPollHandler({
            registry: deps.registry,
            notifyResource: deps.notifyResource,
            fetchAuditLog: async (guildId: string) =>
              (await client!.rest.get(`/guilds/${guildId}/audit-logs?limit=1`)) as {
                audit_log_entries: Array<{ id: string }>;
              },
            pollIntervalMs: 60_000,
          }),
        );
        await client.login(deps.token);
      } catch (err) {
        // Unwind listeners + poll interval before dropping the client — the
        // fetchAuditLog closure dereferences `client`.
        for (const td of teardowns) td();
        teardowns.length = 0;
        await client!.destroy().catch(() => {});
        client = null;
        throw err;
      }
    },
    async stop() {
      for (const td of teardowns) td();
      teardowns.length = 0;
      if (client !== null) {
        await client.destroy();
        client = null;
      }
    },
  };
}
