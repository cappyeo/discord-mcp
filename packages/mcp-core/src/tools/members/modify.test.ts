import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import membersModify from './modify.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';

describe('members_modify', () => {
  it('PATCHes /guilds/:gid/members/:uid and returns updated fields', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    server.use(
      http.patch(`${DISCORD_API}/guilds/:gid/members/:uid`, async ({ request, params }) => {
        const body = (await request.json()) as { nick?: string };
        expect(body.nick).toBe('newnick');
        return HttpResponse.json({
          user: { id: params.uid, username: 'alice' },
          nick: 'newnick',
          roles: ['204183353402423336', '655826858834335716'],
        });
      }),
    );
    const T = membersModify;
    const t = new T(
      { name: 'members_modify', path: 'inline', root: 'inline', store: null as never },
      { name: 'members_modify', enabled: true },
    );
    const r = (await t.run(
      { guild_id: '999000999000999000', user_id: '111122223333444455', nick: 'newnick' },
      { signal: new AbortController().signal },
    )) as { isError: boolean; structuredContent: { nick: string | null; roles: string[] } };
    expect(r.isError).toBe(false);
    expect(r.structuredContent.nick).toBe('newnick');
    expect(r.structuredContent.roles).toEqual(['204183353402423336', '655826858834335716']);
  });
});
