import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import soundboardGetGuild from './get_guild_sound.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';

describe('soundboard_get_guild_sound', () => {
  it('GETs /guilds/:gid/soundboard-sounds/:sid and wraps name', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    server.use(
      http.get(`${DISCORD_API}/guilds/:gid/soundboard-sounds/:sid`, ({ params }) => {
        return HttpResponse.json({
          sound_id: params.sid,
          name: 'airhorn',
          volume: 0.5,
          emoji_id: null,
          emoji_name: null,
          guild_id: params.gid,
          available: true,
        });
      }),
    );
    const T = soundboardGetGuild;
    const t = new T(
      { name: 'soundboard_get_guild_sound', path: 'inline', root: 'inline', store: null as never },
      { name: 'soundboard_get_guild_sound', enabled: true },
    );
    const r = (await t.run(
      { guild_id: '999000999000999000', sound_id: '111111111111111111' },
      { signal: new AbortController().signal },
    )) as { isError: boolean; structuredContent: { name: string; untrusted_text: string } };
    expect(r.isError).toBe(false);
    expect(r.structuredContent.name).toBe('airhorn');
    expect(r.structuredContent.untrusted_text).toContain('untrusted_discord_username');
  });
});
