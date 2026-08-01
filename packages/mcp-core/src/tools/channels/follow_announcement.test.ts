import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import channelsFollowAnnouncement from './follow_announcement.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';

describe('channels_follow_announcement', () => {
  it('POSTs to followers and returns webhook_id', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    server.use(
      http.post(`${DISCORD_API}/channels/:channelId/followers`, async ({ params }) =>
        HttpResponse.json({
          channel_id: params.channelId,
          webhook_id: '999000999000999222',
        }),
      ),
    );
    const T = channelsFollowAnnouncement;
    const t = new T(
      {
        name: 'channels_follow_announcement',
        path: 'inline',
        root: 'inline',
        store: null as never,
      },
      { name: 'channels_follow_announcement', enabled: true },
    );
    const r = (await t.run(
      { channel_id: '111122223333444402', webhook_channel_id: '111122223333444401' },
      { signal: new AbortController().signal },
    )) as { isError: boolean; structuredContent: { webhook_id: string } };
    expect(r.isError).toBe(false);
    expect(r.structuredContent.webhook_id).toBe('999000999000999222');
  });
});
