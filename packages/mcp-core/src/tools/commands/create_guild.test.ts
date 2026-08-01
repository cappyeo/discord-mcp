import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import commandsCreateGuild from './create_guild.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';

describe('commands_create_guild', () => {
  it('POSTs to the guild-scoped endpoint', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    server.use(
      http.post(
        `${DISCORD_API}/applications/:appId/guilds/:guildId/commands`,
        async ({ request, params }) => {
          const body = (await request.json()) as { name: string; description?: string };
          return HttpResponse.json({
            id: 'cmd_g_1',
            application_id: params.appId,
            guild_id: params.guildId,
            name: body.name,
            description: body.description ?? '',
            type: 1,
          });
        },
      ),
    );
    const t = new commandsCreateGuild(
      { name: 'commands_create_guild', path: 'inline', root: 'inline', store: null as never },
      { name: 'commands_create_guild', enabled: true },
    );
    const r = (await t.run(
      {
        application_id: '111111111111111111',
        guild_id: '999000999000999000',
        name: 'guildping',
        description: 'guild ping',
      },
      { signal: new AbortController().signal },
    )) as { isError: boolean; structuredContent: { id: string; guild_id?: string | null } };
    expect(r.isError).toBe(false);
    expect(r.structuredContent.id).toBe('cmd_g_1');
    expect(r.structuredContent.guild_id).toBe('999000999000999000');
  });
});
