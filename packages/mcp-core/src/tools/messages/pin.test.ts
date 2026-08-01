import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import messagesPin from './pin.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';

describe('messages_pin', () => {
  it('PUTs to pins endpoint and returns pinned:true', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    server.use(
      http.put(`${DISCORD_API}/channels/:channelId/pins/:messageId`, async () => {
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const T = messagesPin;
    const t = new T(
      { name: 'messages_pin', path: 'inline', root: 'inline', store: null as never },
      { name: 'messages_pin', enabled: true },
    );
    const r = (await t.run(
      { channel_id: '111122223333444401', message_id: '999000999000999000' },
      { signal: new AbortController().signal },
    )) as {
      isError: boolean;
      structuredContent: { pinned: boolean; message_id: string };
    };
    expect(r.isError).toBe(false);
    expect(r.structuredContent.pinned).toBe(true);
    expect(r.structuredContent.message_id).toBe('999000999000999000');
  });
});
