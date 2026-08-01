import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import guildModifyCurrentVoiceState from './modify_current_voice_state.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';

describe('guild_modify_current_voice_state', () => {
  it('PATCHes /guilds/:gid/voice-states/%40me (URL-encoded @me)', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    let receivedUrl: string | null = null;
    server.use(
      http.patch(`${DISCORD_API}/guilds/:gid/voice-states/%40me`, async ({ request }) => {
        receivedUrl = request.url;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const T = guildModifyCurrentVoiceState;
    const t = new T(
      {
        name: 'guild_modify_current_voice_state',
        path: 'inline',
        root: 'inline',
        store: null as never,
      },
      { name: 'guild_modify_current_voice_state', enabled: true },
    );
    const r = (await t.run(
      { guild_id: '999000999000999000', suppress: false },
      { signal: new AbortController().signal },
    )) as { isError: boolean; structuredContent: { ok: boolean } };
    expect(r.isError).toBe(false);
    expect(r.structuredContent.ok).toBe(true);
    expect(receivedUrl ?? '').toContain('%40me');
  });
});
