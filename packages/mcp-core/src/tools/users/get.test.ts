import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import usersGet from './get.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';

describe('users_get', () => {
  it('GETs user by id and wraps username/global_name', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    server.use(
      http.get(`${DISCORD_API}/users/:userId`, async ({ params }) => {
        return HttpResponse.json({
          id: params.userId,
          username: 'alice',
          global_name: 'Alice',
          avatar: 'avatar_hash',
          bot: false,
        });
      }),
    );
    const T = usersGet;
    const t = new T(
      { name: 'users_get', path: 'inline', root: 'inline', store: null as never },
      { name: 'users_get', enabled: true },
    );
    const r = (await t.run(
      { user_id: '111122223333444499' },
      { signal: new AbortController().signal },
    )) as {
      isError: boolean;
      structuredContent: { id: string; username: string; untrusted_text: string };
    };
    expect(r.isError).toBe(false);
    expect(r.structuredContent.id).toBe('111122223333444499');
    expect(r.structuredContent.username).toBe('alice');
    expect(r.structuredContent.untrusted_text).toContain('untrusted_discord_username');
    expect(r.structuredContent.untrusted_text).toContain('Alice');
  });
});
