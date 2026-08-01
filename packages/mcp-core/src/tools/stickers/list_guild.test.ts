import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import stickersListGuild from './list_guild.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';

describe('stickers_list_guild', () => {
  it('returns the guild sticker list', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    server.use(
      http.get(`${DISCORD_API}/guilds/:guildId/stickers`, async () =>
        HttpResponse.json([
          {
            id: '850000000000000001',
            name: 'WaveHi',
            description: null,
            tags: 'wave',
            format_type: 1,
            available: true,
          },
        ]),
      ),
    );
    const T = stickersListGuild;
    const t = new T(
      { name: 'stickers_list_guild', path: 'inline', root: 'inline', store: null as never },
      { name: 'stickers_list_guild', enabled: true },
    );
    const r = (await t.run(
      { guild_id: '999000999000999000' },
      { signal: new AbortController().signal },
    )) as { isError: boolean; structuredContent: { count: number } };
    expect(r.isError).toBe(false);
    expect(r.structuredContent.count).toBe(1);
  });
});
