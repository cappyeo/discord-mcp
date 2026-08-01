import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import soundboardCreate from './create_guild_sound.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';

describe('soundboard_create_guild_sound', () => {
  it('POSTs /guilds/:gid/soundboard-sounds with data URI', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    server.use(
      http.post(`${DISCORD_API}/guilds/:gid/soundboard-sounds`, async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({
          sound_id: '111111111111111111',
          name: body.name,
          volume: body.volume ?? 1,
          emoji_id: null,
          emoji_name: null,
        });
      }),
    );
    const T = soundboardCreate;
    const t = new T(
      {
        name: 'soundboard_create_guild_sound',
        path: 'inline',
        root: 'inline',
        store: null as never,
      },
      { name: 'soundboard_create_guild_sound', enabled: true },
    );
    const r = (await t.run(
      {
        guild_id: '999000999000999000',
        name: 'airhorn',
        sound: 'data:audio/mpeg;base64,SGVsbG8=',
      },
      { signal: new AbortController().signal },
    )) as { isError: boolean; structuredContent: { sound_id: string; name: string } };
    expect(r.isError).toBe(false);
    expect(r.structuredContent.name).toBe('airhorn');
  });
});
