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

export function bindTypingStartHandler(deps: HandlerDeps): () => void {
  const debouncer = createKeyedDebouncer((uri) => {
    if (deps.registry.has(uri)) void deps.notifyResource(uri);
  }, 5000);
  const handler = (typing: { channel: { id: string } }): void => {
    const uri = `discord://channel/${typing.channel.id}/typing`;
    if (!deps.registry.has(uri)) return;
    debouncer.call(uri);
  };
  deps.client.on('typingStart', handler as never);
  return () => {
    deps.client.off('typingStart', handler as never);
    debouncer.cancelAll();
  };
}
