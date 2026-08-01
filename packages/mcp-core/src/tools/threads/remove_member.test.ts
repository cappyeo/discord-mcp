import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import threadsRemoveMember from './remove_member.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';

describe('threads_remove_member', () => {
  it('DELETEs thread-members/:userId and returns removed:true', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    server.use(
      http.delete(
        `${DISCORD_API}/channels/:threadId/thread-members/:userId`,
        async () => new HttpResponse(null, { status: 204 }),
      ),
    );
    const T = threadsRemoveMember;
    const t = new T(
      { name: 'threads_remove_member', path: 'inline', root: 'inline', store: null as never },
      { name: 'threads_remove_member', enabled: true },
    );
    const r = (await t.run(
      { thread_id: '999000999000999301', user_id: '111111111111111111' },
      { signal: new AbortController().signal },
    )) as { isError: boolean; structuredContent: { removed: boolean } };
    expect(r.isError).toBe(false);
    expect(r.structuredContent.removed).toBe(true);
  });
});
