import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import membersUnban from './unban.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';

describe('members_unban', () => {
  it('DELETEs /guilds/:gid/bans/:uid and returns unbanned:true', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    server.use(
      http.delete(
        `${DISCORD_API}/guilds/:gid/bans/:uid`,
        async () => new HttpResponse(null, { status: 204 }),
      ),
    );
    const T = membersUnban;
    const t = new T(
      { name: 'members_unban', path: 'inline', root: 'inline', store: null as never },
      { name: 'members_unban', enabled: true },
    );
    const r = (await t.run(
      { guild_id: '999000999000999000', user_id: '111122223333444455' },
      { signal: new AbortController().signal },
    )) as { isError: boolean; structuredContent: { unbanned: boolean } };
    expect(r.isError).toBe(false);
    expect(r.structuredContent.unbanned).toBe(true);
  });
});
