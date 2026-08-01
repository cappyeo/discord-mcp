import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import threadsJoin from './join.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';

describe('threads_join', () => {
  it('PUTs to thread-members/@me and returns joined:true', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    server.use(
      http.put(
        `${DISCORD_API}/channels/:threadId/thread-members/%40me`,
        async () => new HttpResponse(null, { status: 204 }),
      ),
    );
    const T = threadsJoin;
    const t = new T(
      { name: 'threads_join', path: 'inline', root: 'inline', store: null as never },
      { name: 'threads_join', enabled: true },
    );
    const r = (await t.run(
      { thread_id: '999000999000999301' },
      { signal: new AbortController().signal },
    )) as { isError: boolean; structuredContent: { joined: boolean } };
    expect(r.isError).toBe(false);
    expect(r.structuredContent.joined).toBe(true);
  });
});
