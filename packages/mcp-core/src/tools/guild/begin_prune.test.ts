import { server } from '@cappyeo/discord-mcp-server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import guildBeginPrune from './begin_prune.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';

describe('guild_begin_prune', () => {
  it('POSTs /guilds/:gid/prune', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    server.use(
      http.post(`${DISCORD_API}/guilds/:gid/prune`, async () => {
        return HttpResponse.json({ pruned: 17 });
      }),
    );
    const T = guildBeginPrune;
    const t = new T(
      { name: 'guild_begin_prune', path: 'inline', root: 'inline', store: null as never },
      { name: 'guild_begin_prune', enabled: true },
    );
    const r = (await t.run(
      { guild_id: '999000999000999000', days: 7 },
      { signal: new AbortController().signal },
    )) as { isError: boolean; structuredContent: { pruned: number } };
    expect(r.isError).toBe(false);
    expect(r.structuredContent.pruned).toBe(17);
  });

  it('sends include_roles as an array in the POST body', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    let sent: { include_roles?: unknown } = {};
    server.use(
      http.post(`${DISCORD_API}/guilds/:gid/prune`, async ({ request }) => {
        sent = (await request.json()) as { include_roles?: unknown };
        return HttpResponse.json({ pruned: 3 });
      }),
    );
    const T = guildBeginPrune;
    const t = new T(
      { name: 'guild_begin_prune', path: 'inline', root: 'inline', store: null as never },
      { name: 'guild_begin_prune', enabled: true },
    );
    const r = (await t.run(
      {
        guild_id: '999000999000999000',
        days: 7,
        include_roles: ['111122223333444401', '111122223333444402'],
      },
      { signal: new AbortController().signal },
    )) as { isError: boolean; structuredContent: { pruned: number } };
    expect(r.isError).toBe(false);
    expect(sent.include_roles).toEqual(['111122223333444401', '111122223333444402']);
  });

  it('declares confirm_required and destructiveHint', () => {
    const T = guildBeginPrune;
    const t = new T(
      { name: 'guild_begin_prune', path: 'inline', root: 'inline', store: null as never },
      { name: 'guild_begin_prune', enabled: true },
    );
    expect(t.preconditions).toContain('confirm_required');
    expect(t.annotations.destructiveHint).toBe(true);
  });
});
