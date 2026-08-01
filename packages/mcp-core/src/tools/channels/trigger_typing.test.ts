import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import channelsTriggerTyping from './trigger_typing.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';

describe('channels_trigger_typing', () => {
  it('POSTs to /typing and returns ok:true', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    server.use(
      http.post(
        `${DISCORD_API}/channels/:channelId/typing`,
        async () => new HttpResponse(null, { status: 204 }),
      ),
    );
    const T = channelsTriggerTyping;
    const t = new T(
      { name: 'channels_trigger_typing', path: 'inline', root: 'inline', store: null as never },
      { name: 'channels_trigger_typing', enabled: true },
    );
    const r = (await t.run(
      { channel_id: '111122223333444401' },
      { signal: new AbortController().signal },
    )) as { isError: boolean; structuredContent: { ok: boolean } };
    expect(r.isError).toBe(false);
    expect(r.structuredContent.ok).toBe(true);
  });
});
