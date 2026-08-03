import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import membersGetCurrentUser from './get_current_user.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';

describe('members_get_current_user', () => {
  it('GETs /users/@me then /guilds/:gid/members/:botId and returns bot member', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    server.use(
      http.get(`${DISCORD_API}/users/%40me`, () => {
        return HttpResponse.json({ id: '655629772673939112' });
      }),
      http.get(`${DISCORD_API}/guilds/:gid/members/655629772673939112`, () => {
        return HttpResponse.json({
          user: { id: '655629772673939112', username: 'discord-mcp-bot' },
          nick: 'BotNick',
          roles: ['204183353402423336'],
          joined_at: '2026-01-15T10:00:00.000+00:00',
          premium_since: null,
        });
      }),
    );
    const T = membersGetCurrentUser;
    const t = new T(
      { name: 'members_get_current_user', path: 'inline', root: 'inline', store: null as never },
      { name: 'members_get_current_user', enabled: true },
    );
    const r = (await t.run(
      { guild_id: '999000999000999000' },
      { signal: new AbortController().signal },
    )) as {
      isError: boolean;
      structuredContent: { user_id: string; nick: string | null; roles: string[] };
    };
    expect(r.isError).toBe(false);
    expect(r.structuredContent.user_id).toBe('655629772673939112');
    expect(r.structuredContent.nick).toBe('BotNick');
    expect(r.structuredContent.roles).toEqual(['204183353402423336']);
  });
});
