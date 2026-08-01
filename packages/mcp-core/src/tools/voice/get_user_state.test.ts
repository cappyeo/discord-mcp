import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import voiceGetUser from './get_user_state.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';

describe('voice_get_user_state', () => {
  it('GETs /guilds/:gid/voice-states/:uid', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    server.use(
      http.get(`${DISCORD_API}/guilds/:gid/voice-states/:uid`, ({ params }) => {
        return HttpResponse.json({
          guild_id: params.gid,
          channel_id: '111122223333444455',
          user_id: params.uid,
          session_id: 'abc',
          deaf: false,
          mute: false,
          self_deaf: false,
          self_mute: false,
          self_video: false,
          suppress: false,
          request_to_speak_timestamp: null,
        });
      }),
    );
    const T = voiceGetUser;
    const t = new T(
      { name: 'voice_get_user_state', path: 'inline', root: 'inline', store: null as never },
      { name: 'voice_get_user_state', enabled: true },
    );
    const r = (await t.run(
      { guild_id: '999000999000999000', user_id: '111122223333444499' },
      { signal: new AbortController().signal },
    )) as { isError: boolean; structuredContent: { user_id: string } };
    expect(r.isError).toBe(false);
    expect(r.structuredContent.user_id).toBe('111122223333444499');
  });
});
