import { server } from '@cappyeo/discord-mcp-server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import guildGetPruneCount from './get_prune_count.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';

describe('guild_get_prune_count', () => {
  it('GETs /guilds/:gid/prune', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    server.use(
      http.get(`${DISCORD_API}/guilds/:gid/prune`, async () => {
        return HttpResponse.json({ pruned: 42 });
      }),
    );
    const T = guildGetPruneCount;
    const t = new T(
      { name: 'guild_get_prune_count', path: 'inline', root: 'inline', store: null as never },
      { name: 'guild_get_prune_count', enabled: true },
    );
    const r = (await t.run(
      { guild_id: '999000999000999000', days: 14 },
      { signal: new AbortController().signal },
    )) as { isError: boolean; structuredContent: { pruned: number } };
    expect(r.isError).toBe(false);
    expect(r.structuredContent.pruned).toBe(42);
  });

  it('sends include_roles as a comma-joined query param', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    let sent: string | null = null;
    server.use(
      http.get(`${DISCORD_API}/guilds/:gid/prune`, async ({ request }) => {
        sent = new URL(request.url).searchParams.get('include_roles');
        return HttpResponse.json({ pruned: 5 });
      }),
    );
    const T = guildGetPruneCount;
    const t = new T(
      { name: 'guild_get_prune_count', path: 'inline', root: 'inline', store: null as never },
      { name: 'guild_get_prune_count', enabled: true },
    );
    const r = (await t.run(
      {
        guild_id: '999000999000999000',
        days: 14,
        include_roles: ['111122223333444401', '111122223333444402'],
      },
      { signal: new AbortController().signal },
    )) as { isError: boolean; structuredContent: { pruned: number } };
    expect(r.isError).toBe(false);
    expect(sent).toBe('111122223333444401,111122223333444402');
  });
});
