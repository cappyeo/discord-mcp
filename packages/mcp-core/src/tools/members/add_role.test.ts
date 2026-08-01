import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import membersAddRole from './add_role.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';

describe('members_add_role', () => {
  it('PUTs /guilds/:gid/members/:uid/roles/:rid and returns added:true', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    server.use(
      http.put(
        `${DISCORD_API}/guilds/:gid/members/:uid/roles/:rid`,
        async () => new HttpResponse(null, { status: 204 }),
      ),
    );
    const T = membersAddRole;
    const t = new T(
      { name: 'members_add_role', path: 'inline', root: 'inline', store: null as never },
      { name: 'members_add_role', enabled: true },
    );
    const r = (await t.run(
      {
        guild_id: '999000999000999000',
        user_id: '111122223333444455',
        role_id: '222233334444555566',
      },
      { signal: new AbortController().signal },
    )) as { isError: boolean; structuredContent: { added: boolean } };
    expect(r.isError).toBe(false);
    expect(r.structuredContent.added).toBe(true);
  });
});
