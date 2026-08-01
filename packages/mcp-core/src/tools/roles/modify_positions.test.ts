import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import rolesModifyPositions from './modify_positions.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';

describe('roles_modify_positions', () => {
  it('PATCHes /guilds/:gid/roles with array body and returns full role list', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    server.use(
      http.patch(`${DISCORD_API}/guilds/:gid/roles`, async ({ request }) => {
        const body = (await request.json()) as Array<{ id: string; position: number }>;
        expect(body[0]?.id).toBe('222233334444555566');
        return HttpResponse.json([
          { id: '222233334444555566', name: 'Moderator', position: 2 },
          { id: '222233334444555567', name: 'Member', position: 1 },
        ]);
      }),
    );
    const T = rolesModifyPositions;
    const t = new T(
      { name: 'roles_modify_positions', path: 'inline', root: 'inline', store: null as never },
      { name: 'roles_modify_positions', enabled: true },
    );
    const r = (await t.run(
      {
        guild_id: '999000999000999000',
        positions: [{ id: '222233334444555566', position: 2 }],
      },
      { signal: new AbortController().signal },
    )) as { isError: boolean; structuredContent: { count: number } };
    expect(r.isError).toBe(false);
    expect(r.structuredContent.count).toBe(2);
  });
});
