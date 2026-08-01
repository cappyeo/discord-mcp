import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import usersLeaveGuild from './leave_guild.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';

describe('users_leave_guild', () => {
  // Routes.userGuild(gid) template `/users/@me/guilds/${gid}` keeps @me unencoded.
  it('DELETEs /users/@me/guilds/:guildId and returns left:true', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    let capturedUrl: string | null = null;
    server.use(
      http.delete(`${DISCORD_API}/users/@me/guilds/:guildId`, ({ request }) => {
        capturedUrl = request.url;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const T = usersLeaveGuild;
    const t = new T(
      { name: 'users_leave_guild', path: 'inline', root: 'inline', store: null as never },
      { name: 'users_leave_guild', enabled: true },
    );
    const r = (await t.run(
      { guild_id: '999000999000999000' },
      { signal: new AbortController().signal },
    )) as { isError: boolean; structuredContent: { left: true; guild_id: string } };
    expect(r.isError).toBe(false);
    expect(r.structuredContent.left).toBe(true);
    expect(capturedUrl).toContain('/users/@me/guilds/999000999000999000');
    expect(capturedUrl).not.toContain('%40me');
  });
});
