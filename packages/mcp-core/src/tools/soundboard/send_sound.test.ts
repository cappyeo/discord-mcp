import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import soundboardSend from './send_sound.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';

describe('soundboard_send_sound', () => {
  it('POSTs /channels/:cid/send-soundboard-sound', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    server.use(
      http.post(
        `${DISCORD_API}/channels/:cid/send-soundboard-sound`,
        async () => new HttpResponse(null, { status: 204 }),
      ),
    );
    const T = soundboardSend;
    const t = new T(
      { name: 'soundboard_send_sound', path: 'inline', root: 'inline', store: null as never },
      { name: 'soundboard_send_sound', enabled: true },
    );
    const r = (await t.run(
      { channel_id: '111122223333444455', sound_id: '111111111111111111' },
      { signal: new AbortController().signal },
    )) as { isError: boolean; structuredContent: { sent: boolean } };
    expect(r.isError).toBe(false);
    expect(r.structuredContent.sent).toBe(true);
  });
});
