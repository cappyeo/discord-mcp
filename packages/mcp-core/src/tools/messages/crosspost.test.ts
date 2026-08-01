import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import messagesCrosspost from './crosspost.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';

describe('messages_crosspost', () => {
  it('publishes the message and returns crossposted:true', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    server.use(
      http.post(
        `${DISCORD_API}/channels/:channelId/messages/:messageId/crosspost`,
        async ({ params }) =>
          HttpResponse.json({
            id: params.messageId,
            channel_id: params.channelId,
            flags: 1 << 1,
          }),
      ),
    );
    const T = messagesCrosspost;
    const t = new T(
      { name: 'messages_crosspost', path: 'inline', root: 'inline', store: null as never },
      { name: 'messages_crosspost', enabled: true },
    );
    const r = (await t.run(
      { channel_id: '111122223333444401', message_id: '999000999000999000' },
      { signal: new AbortController().signal },
    )) as {
      isError: boolean;
      structuredContent: { message_id: string; channel_id: string; crossposted: boolean };
    };
    expect(r.isError).toBe(false);
    expect(r.structuredContent.crossposted).toBe(true);
  });
});
