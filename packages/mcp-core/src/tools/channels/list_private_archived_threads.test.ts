import { server } from '@cappyeo/discord-mcp-server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import channelsListPrivateArchivedThreads from './list_private_archived_threads.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';

describe('channels_list_private_archived_threads', () => {
  it('GETs archived private threads', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    server.use(
      http.get(`${DISCORD_API}/channels/:channelId/threads/archived/private`, async () =>
        HttpResponse.json({
          threads: [
            {
              id: '999000999000999402',
              name: 'private staff chat',
              type: 12,
              parent_id: '111122223333444401',
              owner_id: '316342297552091961',
              thread_metadata: { archived: true, archive_timestamp: '2026-03-15T00:00:00Z' },
            },
          ],
          has_more: false,
        }),
      ),
    );
    const T = channelsListPrivateArchivedThreads;
    const t = new T(
      {
        name: 'channels_list_private_archived_threads',
        path: 'inline',
        root: 'inline',
        store: null as never,
      },
      { name: 'channels_list_private_archived_threads', enabled: true },
    );
    const r = (await t.run(
      { channel_id: '111122223333444401' },
      { signal: new AbortController().signal },
    )) as {
      isError: boolean;
      structuredContent: { has_more: boolean; count: number };
    };
    expect(r.isError).toBe(false);
    expect(r.structuredContent.has_more).toBe(false);
    expect(r.structuredContent.count).toBe(1);
  });
});
