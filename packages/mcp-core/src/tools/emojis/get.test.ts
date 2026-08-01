import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import emojisGet from './get.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';

describe('emojis_get', () => {
  it('returns the single emoji shape', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    server.use(
      http.get(`${DISCORD_API}/guilds/:guildId/emojis/:emojiId`, async ({ params }) =>
        HttpResponse.json({
          id: params.emojiId,
          name: 'sparkle',
          animated: true,
          available: true,
          roles: [],
        }),
      ),
    );
    const T = emojisGet;
    const t = new T(
      { name: 'emojis_get', path: 'inline', root: 'inline', store: null as never },
      { name: 'emojis_get', enabled: true },
    );
    const r = (await t.run(
      { guild_id: '999000999000999000', emoji_id: '850000000000000001' },
      { signal: new AbortController().signal },
    )) as { isError: boolean; structuredContent: { name: string; animated: boolean } };
    expect(r.isError).toBe(false);
    expect(r.structuredContent.name).toBe('sparkle');
    expect(r.structuredContent.animated).toBe(true);
  });
});
