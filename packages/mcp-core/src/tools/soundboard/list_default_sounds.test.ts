import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import soundboardListDefault from './list_default_sounds.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';

describe('soundboard_list_default_sounds', () => {
  it('GETs /soundboard-default-sounds and wraps names', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    server.use(
      http.get(`${DISCORD_API}/soundboard-default-sounds`, () => {
        return HttpResponse.json([
          {
            sound_id: '111111111111111111',
            name: 'quack',
            volume: 1,
            emoji_id: null,
            emoji_name: null,
            available: true,
          },
        ]);
      }),
    );
    const T = soundboardListDefault;
    const t = new T(
      {
        name: 'soundboard_list_default_sounds',
        path: 'inline',
        root: 'inline',
        store: null as never,
      },
      { name: 'soundboard_list_default_sounds', enabled: true },
    );
    const r = (await t.run({}, { signal: new AbortController().signal })) as {
      isError: boolean;
      structuredContent: { count: number; untrusted_names: string };
    };
    expect(r.isError).toBe(false);
    expect(r.structuredContent.count).toBe(1);
    expect(r.structuredContent.untrusted_names).toContain('untrusted_discord_username');
    expect(r.structuredContent.untrusted_names).toContain('quack');
  });
});
