import { server } from '@cappyeo/discord-mcp-server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import channelsListJoinedPrivateArchivedThreads from './list_joined_private_archived_threads.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';

describe('channels_list_joined_private_archived_threads', () => {
  it('GETs joined private archived threads', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    server.use(
      http.get(`${DISCORD_API}/channels/:channelId/users/@me/threads/archived/private`, async () =>
        HttpResponse.json({
          threads: [
            {
              id: '999000999000999403',
              name: 'bot joined chat',
              type: 12,
              parent_id: '111122223333444401',
              owner_id: '974357766999796051',
              thread_metadata: { archived: true, archive_timestamp: '2026-02-15T00:00:00Z' },
            },
          ],
          has_more: false,
        }),
      ),
    );
    const T = channelsListJoinedPrivateArchivedThreads;
    const t = new T(
      {
        name: 'channels_list_joined_private_archived_threads',
        path: 'inline',
        root: 'inline',
        store: null as never,
      },
      { name: 'channels_list_joined_private_archived_threads', enabled: true },
    );
    const r = (await t.run(
      { channel_id: '111122223333444401' },
      { signal: new AbortController().signal },
    )) as { isError: boolean; structuredContent: { count: number } };
    expect(r.isError).toBe(false);
    expect(r.structuredContent.count).toBe(1);
  });
});
