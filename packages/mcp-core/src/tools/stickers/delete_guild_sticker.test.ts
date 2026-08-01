import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import stickersDeleteGuildSticker from './delete_guild_sticker.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';

describe('stickers_delete_guild_sticker', () => {
  it('DELETEs the sticker', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    server.use(
      http.delete(
        `${DISCORD_API}/guilds/:guildId/stickers/:stickerId`,
        async () => new HttpResponse(null, { status: 204 }),
      ),
    );
    const T = stickersDeleteGuildSticker;
    const t = new T(
      {
        name: 'stickers_delete_guild_sticker',
        path: 'inline',
        root: 'inline',
        store: null as never,
      },
      { name: 'stickers_delete_guild_sticker', enabled: true },
    );
    const r = (await t.run(
      { guild_id: '999000999000999000', sticker_id: '850000000000000001' },
      { signal: new AbortController().signal },
    )) as { isError: boolean; structuredContent: { deleted: boolean } };
    expect(r.isError).toBe(false);
    expect(r.structuredContent.deleted).toBe(true);
  });

  it('declares confirm_required + destructiveHint', () => {
    const T = stickersDeleteGuildSticker;
    const t = new T(
      {
        name: 'stickers_delete_guild_sticker',
        path: 'inline',
        root: 'inline',
        store: null as never,
      },
      { name: 'stickers_delete_guild_sticker', enabled: true },
    );
    expect(t.preconditions).toContain('confirm_required');
    expect(t.annotations.destructiveHint).toBe(true);
  });
});
