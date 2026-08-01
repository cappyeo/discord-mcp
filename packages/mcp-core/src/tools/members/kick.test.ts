import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import membersKick from './kick.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';

describe('members_kick', () => {
  it('DELETEs /guilds/:gid/members/:uid and returns kicked:true', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    server.use(
      http.delete(
        `${DISCORD_API}/guilds/:gid/members/:uid`,
        async () => new HttpResponse(null, { status: 204 }),
      ),
    );
    const T = membersKick;
    const t = new T(
      { name: 'members_kick', path: 'inline', root: 'inline', store: null as never },
      { name: 'members_kick', enabled: true },
    );
    const r = (await t.run(
      { guild_id: '999000999000999000', user_id: '111122223333444455' },
      { signal: new AbortController().signal },
    )) as { isError: boolean; structuredContent: { kicked: boolean } };
    expect(r.isError).toBe(false);
    expect(r.structuredContent.kicked).toBe(true);
  });

  it('declares confirm_required and destructiveHint', () => {
    const T = membersKick;
    const t = new T(
      { name: 'members_kick', path: 'inline', root: 'inline', store: null as never },
      { name: 'members_kick', enabled: true },
    );
    expect(t.preconditions).toContain('confirm_required');
    expect(t.annotations.destructiveHint).toBe(true);
  });
});
