import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import rolesModify from './modify.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';

describe('roles_modify', () => {
  it('PATCHes /guilds/:gid/roles/:rid and returns updated role', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    server.use(
      http.patch(`${DISCORD_API}/guilds/:gid/roles/:rid`, async ({ params, request }) => {
        const body = (await request.json()) as { name?: string };
        expect(body.name).toBe('Renamed');
        return HttpResponse.json({
          id: params.rid,
          name: 'Renamed',
          color: 0,
          position: 3,
          permissions: '0',
          mentionable: false,
          hoist: false,
        });
      }),
    );
    const T = rolesModify;
    const t = new T(
      { name: 'roles_modify', path: 'inline', root: 'inline', store: null as never },
      { name: 'roles_modify', enabled: true },
    );
    const r = (await t.run(
      {
        guild_id: '999000999000999000',
        role_id: '222233334444555566',
        name: 'Renamed',
      },
      { signal: new AbortController().signal },
    )) as { isError: boolean; structuredContent: { name: string } };
    expect(r.isError).toBe(false);
    expect(r.structuredContent.name).toBe('Renamed');
  });
});
