import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import membersModifyCurrent from './modify_current.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';

describe('members_modify_current', () => {
  it('PATCHes /guilds/:gid/members/%40me with the new nick', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    server.use(
      http.patch(`${DISCORD_API}/guilds/:gid/members/%40me`, async ({ request }) => {
        const body = (await request.json()) as { nick?: string };
        expect(body.nick).toBe('Bot McBotface');
        return HttpResponse.json({
          user: { id: '655629772673939112', username: 'discord-mcp-bot' },
          nick: 'Bot McBotface',
        });
      }),
    );
    const T = membersModifyCurrent;
    const t = new T(
      { name: 'members_modify_current', path: 'inline', root: 'inline', store: null as never },
      { name: 'members_modify_current', enabled: true },
    );
    const r = (await t.run(
      { guild_id: '999000999000999000', nick: 'Bot McBotface' },
      { signal: new AbortController().signal },
    )) as { isError: boolean; structuredContent: { nick: string | null } };
    expect(r.isError).toBe(false);
    expect(r.structuredContent.nick).toBe('Bot McBotface');
  });
});
