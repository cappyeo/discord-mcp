import { createKeyedDebouncer } from '../debounce.js';
import type { SubscriptionRegistry } from '../subscription_registry.js';

export interface HandlerDeps {
  client: {
    on: (event: string, listener: (...args: unknown[]) => void) => unknown;
    off: (event: string, listener: (...args: unknown[]) => void) => unknown;
  };
  registry: SubscriptionRegistry;
  notifyResource: (uri: string) => Promise<void> | void;
}

export function bindPresenceUpdateHandler(deps: HandlerDeps): () => void {
  const debouncer = createKeyedDebouncer((uri) => {
    if (deps.registry.has(uri)) void deps.notifyResource(uri);
  }, 1000);
  const handler = (_old: unknown, newPresence: { guild: { id: string } }): void => {
    const uri = `discord://guild/${newPresence.guild.id}/members/online`;
    if (!deps.registry.has(uri)) return;
    debouncer.call(uri);
  };
  deps.client.on('presenceUpdate', handler as never);
  return () => {
    deps.client.off('presenceUpdate', handler as never);
    debouncer.cancelAll();
  };
}
