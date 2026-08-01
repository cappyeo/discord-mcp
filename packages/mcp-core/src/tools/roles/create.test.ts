import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import rolesCreate from './create.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';

describe('roles_create', () => {
  it('POSTs /guilds/:gid/roles and returns the new role', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    server.use(
      http.post(`${DISCORD_API}/guilds/:gid/roles`, async ({ request }) => {
        const body = (await request.json()) as { name?: string; permissions?: string };
        expect(body.name).toBe('Moderator');
        expect(body.permissions).toBe('8');
        return HttpResponse.json({
          id: '222233334444555566',
          name: 'Moderator',
          color: 16711680,
          position: 5,
          permissions: '8',
          mentionable: true,
          hoist: true,
          managed: false,
        });
      }),
    );
    const T = rolesCreate;
    const t = new T(
      { name: 'roles_create', path: 'inline', root: 'inline', store: null as never },
      { name: 'roles_create', enabled: true },
    );
    const r = (await t.run(
      {
        guild_id: '999000999000999000',
        name: 'Moderator',
        permissions: '8',
      },
      { signal: new AbortController().signal },
    )) as { isError: boolean; structuredContent: { id: string; name: string } };
    expect(r.isError).toBe(false);
    expect(r.structuredContent.id).toBe('222233334444555566');
    expect(r.structuredContent.name).toBe('Moderator');
  });
});
