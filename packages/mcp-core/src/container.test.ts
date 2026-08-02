import type { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import type { Logger } from 'pino';
import { describe, expect, it } from 'vitest';
import type { Config } from './config.js';
import { type DiscordRuntime, runWithDiscordRuntime } from './container.js';

function runtime(label: string): DiscordRuntime {
  return {
    rest: { label } as unknown as REST,
    logger: { label } as unknown as Logger,
    config: { label } as unknown as Config,
  };
}

describe('Discord runtime container', () => {
  it('keeps concurrent asynchronous runtimes isolated', async () => {
    const alpha = runtime('alpha');
    const bravo = runtime('bravo');

    const [seenAlpha, seenBravo] = await Promise.all([
      runWithDiscordRuntime(alpha, async () => {
        await Promise.resolve();
        return { rest: container.rest, logger: container.logger, config: container.config };
      }),
      runWithDiscordRuntime(bravo, async () => {
        await Promise.resolve();
        return { rest: container.rest, logger: container.logger, config: container.config };
      }),
    ]);

    expect(seenAlpha).toEqual(alpha);
    expect(seenBravo).toEqual(bravo);
  });

  it('preserves direct assignment outside a request for local tools and tests', () => {
    const local = runtime('local');
    container.rest = local.rest;
    container.logger = local.logger;
    container.config = local.config;

    expect({ rest: container.rest, logger: container.logger, config: container.config }).toEqual(
      local,
    );
  });
});
