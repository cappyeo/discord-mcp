import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import stickersGetGuildSticker from './get_guild_sticker.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';

describe('stickers_get_guild_sticker', () => {
  it('returns sticker shape with wrapped description', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    server.use(
      http.get(`${DISCORD_API}/guilds/:guildId/stickers/:stickerId`, async ({ params }) =>
        HttpResponse.json({
          id: params.stickerId,
          name: 'WaveHi',
          description: 'a friendly greeting',
          tags: 'wave',
          format_type: 1,
          available: true,
        }),
      ),
    );
    const T = stickersGetGuildSticker;
    const t = new T(
      {
        name: 'stickers_get_guild_sticker',
        path: 'inline',
        root: 'inline',
        store: null as never,
      },
      { name: 'stickers_get_guild_sticker', enabled: true },
    );
    const r = (await t.run(
      { guild_id: '999000999000999000', sticker_id: '850000000000000001' },
      { signal: new AbortController().signal },
    )) as {
      isError: boolean;
      content: Array<{ text: string }>;
      structuredContent: { name: string };
    };
    expect(r.isError).toBe(false);
    expect(r.structuredContent.name).toBe('WaveHi');
    expect(r.content[0]?.text).toMatch(/<untrusted_discord_embed/);
  });
});
