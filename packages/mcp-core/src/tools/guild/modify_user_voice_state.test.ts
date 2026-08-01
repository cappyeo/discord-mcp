import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import guildModifyUserVoiceState from './modify_user_voice_state.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';

describe('guild_modify_user_voice_state', () => {
  it('PATCHes /guilds/:gid/voice-states/:uid', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    server.use(
      http.patch(
        `${DISCORD_API}/guilds/:gid/voice-states/:uid`,
        async () => new HttpResponse(null, { status: 204 }),
      ),
    );
    const T = guildModifyUserVoiceState;
    const t = new T(
      {
        name: 'guild_modify_user_voice_state',
        path: 'inline',
        root: 'inline',
        store: null as never,
      },
      { name: 'guild_modify_user_voice_state', enabled: true },
    );
    const r = (await t.run(
      {
        guild_id: '999000999000999000',
        user_id: '111122223333444401',
        channel_id: '111122223333444402',
        suppress: true,
      },
      { signal: new AbortController().signal },
    )) as { isError: boolean; structuredContent: { ok: boolean } };
    expect(r.isError).toBe(false);
    expect(r.structuredContent.ok).toBe(true);
  });
});
