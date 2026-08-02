import type { REST } from '@discordjs/rest';
import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { buildServer } from './server.js';

const TOKEN = 'Bot fake.test.token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const BOT_ID = '987654321098765432';

function config(expectedBotId: string) {
  return loadConfig({
    DISCORD_TOKEN: TOKEN,
    DISCORD_EXPECTED_BOT_ID: expectedBotId,
    LOG_LEVEL: 'fatal',
    MCP_AUDIT_ENABLED: 'false',
  } as NodeJS.ProcessEnv);
}

describe('buildServer Discord identity lock', () => {
  it('verifies the expected bot before building the MCP surface', async () => {
    const get = vi.fn(async () => ({ id: BOT_ID, username: 'locked-bot', bot: true }));
    const rest = { get } as unknown as REST;
    const cfg = config(BOT_ID);

    const built = await buildServer({ rest, logger: createLogger(cfg), config: cfg });

    expect(get).toHaveBeenCalledTimes(1);
    expect(built.registeredTools.length).toBeGreaterThan(0);
  });

  it('does not build a server when the configured token belongs to another bot', async () => {
    const get = vi.fn(async () => ({ id: '111122223333444455', bot: true }));
    const rest = { get } as unknown as REST;
    const cfg = config(BOT_ID);

    await expect(buildServer({ rest, logger: createLogger(cfg), config: cfg })).rejects.toThrow(
      'Discord bot identity mismatch',
    );
  });
});
