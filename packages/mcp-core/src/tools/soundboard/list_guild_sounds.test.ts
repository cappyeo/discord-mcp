import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import soundboardListGuild from './list_guild_sounds.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';

describe('soundboard_list_guild_sounds', () => {
  it('GETs /guilds/:gid/soundboard-sounds and wraps names', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    server.use(
      http.get(`${DISCORD_API}/guilds/:gid/soundboard-sounds`, () => {
        return HttpResponse.json({
          items: [
            {
              sound_id: '111111111111111111',
              name: 'airhorn',
              volume: 0.5,
              emoji_id: null,
              emoji_name: null,
              guild_id: '999000999000999000',
              available: true,
            },
          ],
        });
      }),
    );
    const T = soundboardListGuild;
    const t = new T(
      {
        name: 'soundboard_list_guild_sounds',
        path: 'inline',
        root: 'inline',
        store: null as never,
      },
      { name: 'soundboard_list_guild_sounds', enabled: true },
    );
    const r = (await t.run(
      { guild_id: '999000999000999000' },
      { signal: new AbortController().signal },
    )) as { isError: boolean; structuredContent: { count: number; untrusted_names: string } };
    expect(r.isError).toBe(false);
    expect(r.structuredContent.count).toBe(1);
    expect(r.structuredContent.untrusted_names).toContain('airhorn');
  });
});
