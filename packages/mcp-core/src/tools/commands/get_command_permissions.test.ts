import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import commandsGetCommandPermissions from './get_command_permissions.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';

describe('commands_get_command_permissions', () => {
  it('GETs single command permissions', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    server.use(
      http.get(
        `${DISCORD_API}/applications/:appId/guilds/:guildId/commands/:cmdId/permissions`,
        ({ params }) =>
          HttpResponse.json({
            id: params.cmdId,
            application_id: params.appId,
            guild_id: params.guildId,
            permissions: [{ id: '222', type: 2, permission: true }],
          }),
      ),
    );
    const t = new commandsGetCommandPermissions(
      {
        name: 'commands_get_command_permissions',
        path: 'inline',
        root: 'inline',
        store: null as never,
      },
      { name: 'commands_get_command_permissions', enabled: true },
    );
    const r = (await t.run(
      {
        application_id: '111111111111111111',
        guild_id: '999000999000999000',
        command_id: '222222222222222222',
      },
      { signal: new AbortController().signal },
    )) as {
      isError: boolean;
      structuredContent: { permissions: Array<{ id: string }> };
    };
    expect(r.isError).toBe(false);
    expect(r.structuredContent.permissions[0]!.id).toBe('222');
  });
});
