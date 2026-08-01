import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import stickersModifyGuildSticker from './modify_guild_sticker.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';

describe('stickers_modify_guild_sticker', () => {
  it('PATCHes the sticker and returns updated shape', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    server.use(
      http.patch(
        `${DISCORD_API}/guilds/:guildId/stickers/:stickerId`,
        async ({ params, request }) => {
          const body = (await request.json()) as { name?: string; description?: string };
          return HttpResponse.json({
            id: params.stickerId,
            name: body.name ?? 'old',
            description: body.description ?? null,
            tags: 'wave',
            format_type: 1,
            available: true,
          });
        },
      ),
    );
    const T = stickersModifyGuildSticker;
    const t = new T(
      {
        name: 'stickers_modify_guild_sticker',
        path: 'inline',
        root: 'inline',
        store: null as never,
      },
      { name: 'stickers_modify_guild_sticker', enabled: true },
    );
    const r = (await t.run(
      {
        guild_id: '999000999000999000',
        sticker_id: '850000000000000001',
        name: 'WaveHi2',
      },
      { signal: new AbortController().signal },
    )) as { isError: boolean; structuredContent: { name: string } };
    expect(r.isError).toBe(false);
    expect(r.structuredContent.name).toBe('WaveHi2');
  });
});
