import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import commandsBulkOverwriteGuild from './bulk_overwrite_guild.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';

describe('commands_bulk_overwrite_guild', () => {
  it('PUTs to guild-scoped endpoint', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    server.use(
      http.put(
        `${DISCORD_API}/applications/:appId/guilds/:guildId/commands`,
        async ({ request }) => {
          const body = (await request.json()) as Array<{ name: string }>;
          return HttpResponse.json(body.map((b, i) => ({ id: `g${i}`, name: b.name, type: 1 })));
        },
      ),
    );
    const t = new commandsBulkOverwriteGuild(
      {
        name: 'commands_bulk_overwrite_guild',
        path: 'inline',
        root: 'inline',
        store: null as never,
      },
      { name: 'commands_bulk_overwrite_guild', enabled: true },
    );
    const r = (await t.run(
      {
        application_id: '111111111111111111',
        guild_id: '999000999000999000',
        commands: [{ name: 'a', description: 'a' }],
      },
      { signal: new AbortController().signal },
    )) as { isError: boolean; structuredContent: { count: number } };
    expect(r.isError).toBe(false);
    expect(r.structuredContent.count).toBe(1);
  });
});
