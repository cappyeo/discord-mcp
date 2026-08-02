import { AsyncLocalStorage } from 'node:async_hooks';
import type { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import type { Logger } from 'pino';
import type { Config } from './config.js';

/**
 * Runtime dependencies consumed by the existing tool pieces through Sapphire's
 * `container`. The local stdio server has one runtime for its process; a
 * public HTTP server needs a distinct runtime for every authenticated request.
 */
export interface DiscordRuntime {
  rest: REST;
  logger: Logger;
  config: Config;
}

const runtimeStore = new AsyncLocalStorage<DiscordRuntime>();
const fallbackRuntime: Partial<DiscordRuntime> = {};

type RuntimeKey = keyof DiscordRuntime;

function readRuntime<Key extends RuntimeKey>(key: Key): DiscordRuntime[Key] {
  const value = runtimeStore.getStore()?.[key] ?? fallbackRuntime[key];
  if (value === undefined) {
    throw new Error(`Discord runtime is not configured (${key}).`);
  }
  return value as DiscordRuntime[Key];
}

function writeRuntime<Key extends RuntimeKey>(key: Key, value: DiscordRuntime[Key]): void {
  const activeRuntime = runtimeStore.getStore();
  if (activeRuntime !== undefined) {
    activeRuntime[key] = value;
    return;
  }
  fallbackRuntime[key] = value;
}

// Tool modules import Sapphire's singleton `container` directly. Turn its
// three runtime fields into AsyncLocalStorage-backed accessors once, preserving
// direct assignment for existing unit tests and local one-process startup.
for (const key of ['rest', 'logger', 'config'] as const) {
  Object.defineProperty(container, key, {
    configurable: true,
    enumerable: true,
    get: () => readRuntime(key),
    set: (value: DiscordRuntime[typeof key]) => writeRuntime(key, value),
  });
}

/** Run work with an isolated Discord runtime that survives async boundaries. */
export function runWithDiscordRuntime<T>(
  runtime: DiscordRuntime,
  fn: () => Promise<T>,
): Promise<T> {
  return runtimeStore.run(runtime, fn);
}

declare module '@sapphire/pieces' {
  interface Container {
    rest: REST;
    logger: Logger;
    config: Config;
  }
}
