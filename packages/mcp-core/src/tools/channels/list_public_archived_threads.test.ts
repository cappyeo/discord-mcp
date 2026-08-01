import { server } from '@cappyeo/discord-mcp-server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import channelsListPublicArchivedThreads from './list_public_archived_threads.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';

describe('channels_list_public_archived_threads', () => {
  it('GETs archived public threads and reports has_more', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    server.use(
      http.get(`${DISCORD_API}/channels/:channelId/threads/archived/public`, async () =>
        HttpResponse.json({
          threads: [
            {
              id: '999000999000999401',
              name: 'archived feature chat',
              type: 11,
              parent_id: '111122223333444401',
              owner_id: '537711014240270104',
              thread_metadata: { archived: true, archive_timestamp: '2026-04-01T00:00:00Z' },
            },
          ],
          has_more: true,
        }),
      ),
    );
    const T = channelsListPublicArchivedThreads;
    const t = new T(
      {
        name: 'channels_list_public_archived_threads',
        path: 'inline',
        root: 'inline',
        store: null as never,
      },
      { name: 'channels_list_public_archived_threads', enabled: true },
    );
    const r = (await t.run(
      { channel_id: '111122223333444401', limit: 25 },
      { signal: new AbortController().signal },
    )) as {
      isError: boolean;
      content: Array<{ type: string; text: string }>;
      structuredContent: { has_more: boolean; count: number };
    };
    expect(r.isError).toBe(false);
    expect(r.structuredContent.has_more).toBe(true);
    expect(r.structuredContent.count).toBe(1);
    expect(r.content[0]!.text).toContain('untrusted_discord_message');
  });
});
