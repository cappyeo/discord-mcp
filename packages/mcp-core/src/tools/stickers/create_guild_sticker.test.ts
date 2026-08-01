import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import stickersCreateGuildSticker from './create_guild_sticker.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';

describe('stickers_create_guild_sticker', () => {
  it('uploads multipart and returns the new sticker', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    server.use(
      http.post(`${DISCORD_API}/guilds/:guildId/stickers`, async ({ params }) =>
        HttpResponse.json({
          id: '850000000000000099',
          name: 'WaveHi',
          description: 'a friendly wave',
          tags: 'wave',
          format_type: 1,
          available: true,
          guild_id: params.guildId,
        }),
      ),
    );
    const T = stickersCreateGuildSticker;
    const t = new T(
      {
        name: 'stickers_create_guild_sticker',
        path: 'inline',
        root: 'inline',
        store: null as never,
      },
      { name: 'stickers_create_guild_sticker', enabled: true },
    );
    const tinyPng = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').toString('base64');
    const r = (await t.run(
      {
        guild_id: '999000999000999000',
        name: 'WaveHi',
        description: 'a friendly wave',
        tags: 'wave',
        file_format: 1,
        file_data: `data:image/png;base64,${tinyPng}`,
      },
      { signal: new AbortController().signal },
    )) as { isError: boolean; structuredContent: { id: string; name: string } };
    expect(r.isError).toBe(false);
    expect(r.structuredContent.id).toBe('850000000000000099');
    expect(r.structuredContent.name).toBe('WaveHi');
  });
});
