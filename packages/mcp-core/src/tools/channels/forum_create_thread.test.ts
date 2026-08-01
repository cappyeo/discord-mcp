import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import channelsForumCreateThread from './forum_create_thread.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';

describe('channels_forum_create_thread', () => {
  it('POSTs forum thread body and projects {thread_id, parent_id, message_id}', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    let receivedBody: unknown = null;
    server.use(
      http.post(`${DISCORD_API}/channels/:channelId/threads`, async ({ params, request }) => {
        receivedBody = await request.json();
        return HttpResponse.json({
          id: '999000999000999500',
          parent_id: params.channelId,
          type: 11,
          message: { id: '999000999000999501' },
        });
      }),
    );
    const T = channelsForumCreateThread;
    const t = new T(
      {
        name: 'channels_forum_create_thread',
        path: 'inline',
        root: 'inline',
        store: null as never,
      },
      { name: 'channels_forum_create_thread', enabled: true },
    );
    const r = (await t.run(
      {
        channel_id: '111122223333444444',
        name: 'help with deploys',
        message: { content: 'Anyone hit ETIMEDOUT on Cloud Run?' },
      },
      { signal: new AbortController().signal },
    )) as {
      isError: boolean;
      structuredContent: { thread_id: string; message_id: string };
    };
    expect(r.isError).toBe(false);
    expect(r.structuredContent.thread_id).toBe('999000999000999500');
    expect(r.structuredContent.message_id).toBe('999000999000999501');
    expect(receivedBody).toMatchObject({
      name: 'help with deploys',
      message: { content: 'Anyone hit ETIMEDOUT on Cloud Run?' },
    });
  });
});
