import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../../config.js';
import { blueprintSigningSecret } from './blueprint.trust.js';

const DISCORD_TOKEN = 'test.discord.token.'.padEnd(64, 'x');

describe('blueprint caller trust boundary', () => {
  it('keeps local profile compatibility and binds HTTP plans to its bearer principal', () => {
    const first = loadConfig({
      DISCORD_TOKEN,
      DISCORD_MCP_ACCESS_TOKEN: 'a'.repeat(32),
    });
    const second = loadConfig({
      DISCORD_TOKEN,
      DISCORD_MCP_ACCESS_TOKEN: 'b'.repeat(32),
    });

    expect(blueprintSigningSecret(first, 'stdio_profile')).toBe(DISCORD_TOKEN);
    expect(blueprintSigningSecret(first, 'http_access_token')).not.toBe(
      blueprintSigningSecret(second, 'http_access_token'),
    );
  });
});
