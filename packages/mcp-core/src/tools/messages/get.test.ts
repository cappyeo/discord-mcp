import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import messagesGet from './get.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';

describe('messages_get', () => {
  it('returns dualResult with wrapped content', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken(
      'fake-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    );
    server.use(
      http.get(`${DISCORD_API}/channels/:channelId/messages/:messageId`, async ({ params }) =>
        HttpResponse.json({
          id: params.messageId,
          channel_id: params.channelId,
          content: 'hello there',
          author: { id: '111122223333444401', username: 'alice', global_name: 'Alice' },
          timestamp: '2026-04-28T12:00:00.000000+00:00',
          edited_timestamp: null,
          pinned: false,
        }),
      ),
    );

    const T = messagesGet;
    const t = new T(
      { name: 'messages_get', path: 'inline', root: 'inline', store: null as never },
      { name: 'messages_get', enabled: true },
    );
    const r = (await t.run(
      { channel_id: '112233445566778899', message_id: '999000999000999000' },
      { signal: new AbortController().signal },
    )) as {
      isError: boolean;
      content: Array<{ text: string }>;
      structuredContent: { message_id: string; content: string; pinned: boolean };
    };
    expect(r.isError).toBe(false);
    expect(r.structuredContent.message_id).toBe('999000999000999000');
    expect(r.structuredContent.content).toBe('hello there');
    expect(r.structuredContent.pinned).toBe(false);
    expect(r.content[0]?.text).toMatch(/<untrusted_discord_messages/);
  });
});
