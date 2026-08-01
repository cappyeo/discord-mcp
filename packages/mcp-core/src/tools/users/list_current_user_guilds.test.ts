import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import usersListCurrentUserGuilds from './list_current_user_guilds.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';

describe('users_list_current_user_guilds', () => {
  // Routes.userGuilds() is a template literal — `@me` passes through unencoded.
  it('GETs /users/@me/guilds with raw @me in URL', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    let capturedUrl: string | null = null;
    server.use(
      http.get(`${DISCORD_API}/users/@me/guilds`, async ({ request }) => {
        capturedUrl = request.url;
        const url = new URL(request.url);
        expect(url.searchParams.get('limit')).toBe('5');
        expect(url.searchParams.get('with_counts')).toBe('true');
        return HttpResponse.json([
          {
            id: '999000999000999000',
            name: 'Cool Guild',
            icon: null,
            owner: true,
            permissions: '8',
            features: ['COMMUNITY'],
            approximate_member_count: 100,
            approximate_presence_count: 42,
          },
        ]);
      }),
    );
    const T = usersListCurrentUserGuilds;
    const t = new T(
      {
        name: 'users_list_current_user_guilds',
        path: 'inline',
        root: 'inline',
        store: null as never,
      },
      { name: 'users_list_current_user_guilds', enabled: true },
    );
    const r = (await t.run(
      { limit: 5, with_counts: true },
      { signal: new AbortController().signal },
    )) as {
      isError: boolean;
      structuredContent: {
        guilds: Array<{ id: string; owner: boolean; approximate_member_count?: number }>;
        count: number;
        untrusted_names: string;
      };
    };
    expect(r.isError).toBe(false);
    expect(r.structuredContent.count).toBe(1);
    expect(r.structuredContent.guilds[0]!.approximate_member_count).toBe(100);
    expect(r.structuredContent.untrusted_names).toContain('Cool Guild');
    expect(capturedUrl).toContain('/users/@me/guilds');
    expect(capturedUrl).not.toContain('%40me');
  });
});
