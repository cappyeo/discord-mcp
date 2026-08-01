import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import commandsGetGuildCommandPermissions from './get_guild_command_permissions.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';

describe('commands_get_guild_command_permissions', () => {
  it('GETs per-guild permissions list', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    server.use(
      http.get(
        `${DISCORD_API}/applications/:appId/guilds/:guildId/commands/permissions`,
        ({ params }) =>
          HttpResponse.json([
            {
              id: 'cmd1',
              application_id: params.appId,
              guild_id: params.guildId,
              permissions: [{ id: '111', type: 1, permission: true }],
            },
          ]),
      ),
    );
    const t = new commandsGetGuildCommandPermissions(
      {
        name: 'commands_get_guild_command_permissions',
        path: 'inline',
        root: 'inline',
        store: null as never,
      },
      { name: 'commands_get_guild_command_permissions', enabled: true },
    );
    const r = (await t.run(
      { application_id: '111111111111111111', guild_id: '999000999000999000' },
      { signal: new AbortController().signal },
    )) as { isError: boolean; structuredContent: { count: number } };
    expect(r.isError).toBe(false);
    expect(r.structuredContent.count).toBe(1);
  });
});
