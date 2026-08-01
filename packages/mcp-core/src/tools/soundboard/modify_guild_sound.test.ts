import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import soundboardModify from './modify_guild_sound.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';

describe('soundboard_modify_guild_sound', () => {
  it('PATCHes /guilds/:gid/soundboard-sounds/:sid', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    server.use(
      http.patch(
        `${DISCORD_API}/guilds/:gid/soundboard-sounds/:sid`,
        async ({ params, request }) => {
          const body = (await request.json()) as Record<string, unknown>;
          return HttpResponse.json({
            sound_id: params.sid,
            name: (body.name as string) ?? 'unchanged',
            volume: 1,
            emoji_id: null,
            emoji_name: null,
          });
        },
      ),
    );
    const T = soundboardModify;
    const t = new T(
      {
        name: 'soundboard_modify_guild_sound',
        path: 'inline',
        root: 'inline',
        store: null as never,
      },
      { name: 'soundboard_modify_guild_sound', enabled: true },
    );
    const r = (await t.run(
      { guild_id: '999000999000999000', sound_id: '111111111111111111', name: 'renamed' },
      { signal: new AbortController().signal },
    )) as { isError: boolean; structuredContent: { name: string } };
    expect(r.isError).toBe(false);
    expect(r.structuredContent.name).toBe('renamed');
  });
});
