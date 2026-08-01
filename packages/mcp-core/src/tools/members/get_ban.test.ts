import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import membersGetBan from './get_ban.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';

describe('members_get_ban', () => {
  it('GETs /guilds/:gid/bans/:uid and returns ban entry', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    server.use(
      http.get(`${DISCORD_API}/guilds/:gid/bans/:uid`, ({ params }) => {
        return HttpResponse.json({
          user: { id: params.uid, username: 'evil' },
          reason: 'spam',
        });
      }),
    );
    const T = membersGetBan;
    const t = new T(
      { name: 'members_get_ban', path: 'inline', root: 'inline', store: null as never },
      { name: 'members_get_ban', enabled: true },
    );
    const r = (await t.run(
      { guild_id: '999000999000999000', user_id: '111122223333444455' },
      { signal: new AbortController().signal },
    )) as { isError: boolean; structuredContent: { username: string; reason: string | null } };
    expect(r.isError).toBe(false);
    expect(r.structuredContent.username).toBe('evil');
    expect(r.structuredContent.reason).toBe('spam');
  });
});
