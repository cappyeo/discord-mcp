import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import membersListBans from './list_bans.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';

describe('members_list_bans', () => {
  it('GETs /guilds/:gid/bans and returns projected list', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    server.use(
      http.get(`${DISCORD_API}/guilds/:gid/bans`, () => {
        return HttpResponse.json([
          { user: { id: '111122223333444401', username: 'evil1' }, reason: 'spam' },
          { user: { id: '111122223333444402', username: 'evil2' }, reason: null },
        ]);
      }),
    );
    const T = membersListBans;
    const t = new T(
      { name: 'members_list_bans', path: 'inline', root: 'inline', store: null as never },
      { name: 'members_list_bans', enabled: true },
    );
    const r = (await t.run(
      { guild_id: '999000999000999000' },
      { signal: new AbortController().signal },
    )) as {
      isError: boolean;
      structuredContent: {
        count: number;
        bans: Array<{ user_id: string; username: string; reason: string | null }>;
      };
    };
    expect(r.isError).toBe(false);
    expect(r.structuredContent.count).toBe(2);
    expect(r.structuredContent.bans[0]?.username).toBe('evil1');
  });
});
