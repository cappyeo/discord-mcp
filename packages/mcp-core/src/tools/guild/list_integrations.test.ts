import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import guildListIntegrations from './list_integrations.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';

describe('guild_list_integrations', () => {
  it('GETs /guilds/:gid/integrations', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    server.use(
      http.get(`${DISCORD_API}/guilds/:gid/integrations`, async () => {
        return HttpResponse.json([
          { id: '111122223333444401', name: 'Twitch', type: 'twitch', enabled: true },
        ]);
      }),
    );
    const T = guildListIntegrations;
    const t = new T(
      { name: 'guild_list_integrations', path: 'inline', root: 'inline', store: null as never },
      { name: 'guild_list_integrations', enabled: true },
    );
    const r = (await t.run(
      { guild_id: '999000999000999000' },
      { signal: new AbortController().signal },
    )) as { isError: boolean; structuredContent: { count: number } };
    expect(r.isError).toBe(false);
    expect(r.structuredContent.count).toBe(1);
  });
});
