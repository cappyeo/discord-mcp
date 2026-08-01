import { server } from '@cappyeo/discord-mcp-server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import stickersListPacks from './list_packs.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';

describe('stickers_list_packs', () => {
  it('returns sticker_packs array', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    server.use(
      http.get(`${DISCORD_API}/sticker-packs`, async () =>
        HttpResponse.json({
          sticker_packs: [
            {
              id: '353648979511735946',
              name: 'Pack 1',
              sku_id: 'sku1',
              description: 'desc',
              stickers: [{ id: '850000000000000001', name: 'wave' }],
            },
          ],
        }),
      ),
    );
    const T = stickersListPacks;
    const t = new T(
      { name: 'stickers_list_packs', path: 'inline', root: 'inline', store: null as never },
      { name: 'stickers_list_packs', enabled: true },
    );
    const r = (await t.run({}, { signal: new AbortController().signal })) as {
      isError: boolean;
      structuredContent: { count: number };
    };
    expect(r.isError).toBe(false);
    expect(r.structuredContent.count).toBe(1);
  });
});
