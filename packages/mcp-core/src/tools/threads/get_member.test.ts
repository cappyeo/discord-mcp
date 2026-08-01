import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import threadsGetMember from './get_member.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';

describe('threads_get_member', () => {
  it('GETs thread-members/:userId and returns join_timestamp+flags', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    server.use(
      http.get(`${DISCORD_API}/channels/:threadId/thread-members/:userId`, async ({ params }) =>
        HttpResponse.json({
          id: params.threadId,
          user_id: params.userId,
          join_timestamp: '2026-04-29T12:00:00.000Z',
          flags: 1,
        }),
      ),
    );
    const T = threadsGetMember;
    const t = new T(
      { name: 'threads_get_member', path: 'inline', root: 'inline', store: null as never },
      { name: 'threads_get_member', enabled: true },
    );
    const r = (await t.run(
      { thread_id: '999000999000999301', user_id: '111111111111111111' },
      { signal: new AbortController().signal },
    )) as {
      isError: boolean;
      structuredContent: { join_timestamp: string; flags: number };
    };
    expect(r.isError).toBe(false);
    expect(r.structuredContent.join_timestamp).toBe('2026-04-29T12:00:00.000Z');
    expect(r.structuredContent.flags).toBe(1);
  });
});
