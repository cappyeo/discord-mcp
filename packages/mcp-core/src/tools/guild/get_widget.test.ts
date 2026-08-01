import { server } from '@cappyeo/discord-mcp-server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import guildGetWidget from './get_widget.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';

describe('guild_get_widget', () => {
  it('GETs /guilds/:gid/widget.json without bot auth', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    let receivedAuth: string | null = null;
    server.use(
      http.get(`${DISCORD_API}/guilds/:gid/widget.json`, async ({ request }) => {
        receivedAuth = request.headers.get('authorization');
        return HttpResponse.json({
          id: '999000999000999000',
          name: 'My Server',
          instant_invite: 'https://discord.gg/abc',
          channels: [{ id: '111122223333444401', name: 'general', position: 0 }],
          members: [{ id: '394302850041909017', username: 'alice', status: 'online' }],
          presence_count: 5,
        });
      }),
    );
    const T = guildGetWidget;
    const t = new T(
      { name: 'guild_get_widget', path: 'inline', root: 'inline', store: null as never },
      { name: 'guild_get_widget', enabled: true },
    );
    const r = (await t.run(
      { guild_id: '999000999000999000' },
      { signal: new AbortController().signal },
    )) as { isError: boolean; structuredContent: { presence_count: number } };
    expect(r.isError).toBe(false);
    expect(r.structuredContent.presence_count).toBe(5);
    expect(receivedAuth ?? '').not.toMatch(/^Bot /);
  });
});
