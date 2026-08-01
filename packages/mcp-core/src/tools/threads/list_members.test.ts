import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import threadsListMembers from './list_members.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';

describe('threads_list_members', () => {
  it('GETs thread-members and returns members + count', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    server.use(
      http.get(`${DISCORD_API}/channels/:threadId/thread-members`, async () =>
        HttpResponse.json([
          {
            id: '999000999000999301',
            user_id: '111111111111111111',
            join_timestamp: '2026-04-29T12:00:00.000Z',
            flags: 1,
          },
          {
            id: '999000999000999301',
            user_id: '222222222222222222',
            join_timestamp: '2026-04-29T12:05:00.000Z',
            flags: 0,
          },
        ]),
      ),
    );
    const T = threadsListMembers;
    const t = new T(
      { name: 'threads_list_members', path: 'inline', root: 'inline', store: null as never },
      { name: 'threads_list_members', enabled: true },
    );
    const r = (await t.run(
      { thread_id: '999000999000999301' },
      { signal: new AbortController().signal },
    )) as {
      isError: boolean;
      structuredContent: { count: number; members: Array<{ user_id: string }> };
    };
    expect(r.isError).toBe(false);
    expect(r.structuredContent.count).toBe(2);
    expect(r.structuredContent.members[0]!.user_id).toBe('111111111111111111');
  });
});
