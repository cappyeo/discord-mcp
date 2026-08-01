import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import membersBan from './ban.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';

describe('members_ban', () => {
  it('PUTs /guilds/:gid/bans/:uid and returns banned:true', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    server.use(
      http.put(
        `${DISCORD_API}/guilds/:gid/bans/:uid`,
        async () => new HttpResponse(null, { status: 204 }),
      ),
    );
    const T = membersBan;
    const t = new T(
      { name: 'members_ban', path: 'inline', root: 'inline', store: null as never },
      { name: 'members_ban', enabled: true },
    );
    const r = (await t.run(
      { guild_id: '999000999000999000', user_id: '111122223333444455' },
      { signal: new AbortController().signal },
    )) as { isError: boolean; structuredContent: { banned: boolean } };
    expect(r.isError).toBe(false);
    expect(r.structuredContent.banned).toBe(true);
  });

  it('declares confirm_required and destructiveHint', () => {
    const T = membersBan;
    const t = new T(
      { name: 'members_ban', path: 'inline', root: 'inline', store: null as never },
      { name: 'members_ban', enabled: true },
    );
    expect(t.preconditions).toContain('confirm_required');
    expect(t.annotations.destructiveHint).toBe(true);
  });
});
