import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import eventsListUsers from './list_users.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';

describe('events_list_users', () => {
  it('GETs RSVP users for a scheduled event', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    server.use(
      http.get(
        `${DISCORD_API}/guilds/:guildId/scheduled-events/:eventId/users`,
        async ({ request }) => {
          const url = new URL(request.url);
          expect(url.searchParams.get('limit')).toBe('25');
          expect(url.searchParams.get('with_member')).toBe('true');
          return HttpResponse.json([
            {
              guild_scheduled_event_id: '111122223333444402',
              user: {
                id: '111122223333444499',
                username: 'alice',
                global_name: 'Alice',
                bot: false,
              },
              member: { nick: 'Ally', roles: [], joined_at: '2024-01-01T00:00:00Z' },
            },
          ]);
        },
      ),
    );
    const T = eventsListUsers;
    const t = new T(
      { name: 'events_list_users', path: 'inline', root: 'inline', store: null as never },
      { name: 'events_list_users', enabled: true },
    );
    const r = (await t.run(
      {
        guild_id: '999000999000999000',
        event_id: '111122223333444402',
        limit: 25,
        with_member: true,
      },
      { signal: new AbortController().signal },
    )) as {
      isError: boolean;
      structuredContent: {
        users: Array<{ user_id: string; username: string; nick: string | null }>;
        count: number;
      };
    };
    expect(r.isError).toBe(false);
    expect(r.structuredContent.count).toBe(1);
    expect(r.structuredContent.users[0]!.username).toBe('Alice');
    expect(r.structuredContent.users[0]!.nick).toBe('Ally');
  });
});
