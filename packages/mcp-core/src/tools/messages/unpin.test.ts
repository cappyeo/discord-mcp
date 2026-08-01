import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import messagesUnpin from './unpin.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';

describe('messages_unpin', () => {
  it('DELETEs the pin and returns unpinned:true', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    server.use(
      http.delete(
        `${DISCORD_API}/channels/:channelId/pins/:messageId`,
        async () => new HttpResponse(null, { status: 204 }),
      ),
    );
    const T = messagesUnpin;
    const t = new T(
      { name: 'messages_unpin', path: 'inline', root: 'inline', store: null as never },
      { name: 'messages_unpin', enabled: true },
    );
    const r = (await t.run(
      { channel_id: '111122223333444401', message_id: '999000999000999000' },
      { signal: new AbortController().signal },
    )) as { isError: boolean; structuredContent: { unpinned: boolean } };
    expect(r.isError).toBe(false);
    expect(r.structuredContent.unpinned).toBe(true);
  });
});
