import { server } from '@cappyeo/discord-mcp-server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import membersList from './list.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';

describe('members_list', () => {
  it('GETs /guilds/:gid/members and wraps user-authored fields', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    server.use(
      http.get(`${DISCORD_API}/guilds/:gid/members`, ({ request }) => {
        const url = new URL(request.url);
        expect(url.searchParams.get('limit')).toBe('2');
        return HttpResponse.json([
          {
            user: { id: '111122223333444401', username: 'alice', global_name: 'Alice' },
            nick: 'al',
            roles: ['204183353402423336'],
            joined_at: '2026-01-15T10:00:00.000+00:00',
            premium_since: null,
            pending: false,
          },
          {
            user: { id: '111122223333444402', username: 'bob', global_name: null },
            nick: null,
            roles: [],
            joined_at: '2026-01-16T10:00:00.000+00:00',
            premium_since: null,
            pending: false,
          },
        ]);
      }),
    );
    const T = membersList;
    const t = new T(
      { name: 'members_list', path: 'inline', root: 'inline', store: null as never },
      { name: 'members_list', enabled: true },
    );
    const r = (await t.run(
      { guild_id: '999000999000999000', limit: 2 },
      { signal: new AbortController().signal },
    )) as {
      isError: boolean;
      structuredContent: { count: number; untrusted_names: string };
    };
    expect(r.isError).toBe(false);
    expect(r.structuredContent.count).toBe(2);
    expect(r.structuredContent.untrusted_names).toContain('untrusted_discord_channel_topic');
    expect(r.structuredContent.untrusted_names).toContain('alice');
  });
});
