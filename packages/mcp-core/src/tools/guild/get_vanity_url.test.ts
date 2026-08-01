import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import guildGetVanityUrl from './get_vanity_url.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';

describe('guild_get_vanity_url', () => {
  it('GETs /guilds/:gid/vanity-url', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    server.use(
      http.get(`${DISCORD_API}/guilds/:gid/vanity-url`, async () => {
        return HttpResponse.json({ code: 'mygild', uses: 123 });
      }),
    );
    const T = guildGetVanityUrl;
    const t = new T(
      { name: 'guild_get_vanity_url', path: 'inline', root: 'inline', store: null as never },
      { name: 'guild_get_vanity_url', enabled: true },
    );
    const r = (await t.run(
      { guild_id: '999000999000999000' },
      { signal: new AbortController().signal },
    )) as { isError: boolean; structuredContent: { code: string; uses: number } };
    expect(r.isError).toBe(false);
    expect(r.structuredContent.code).toBe('mygild');
    expect(r.structuredContent.uses).toBe(123);
  });
});
