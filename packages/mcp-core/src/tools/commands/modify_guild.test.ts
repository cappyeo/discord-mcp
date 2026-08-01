import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import commandsModifyGuild from './modify_guild.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';

describe('commands_modify_guild', () => {
  it('PATCHes the guild command', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    server.use(
      http.patch(
        `${DISCORD_API}/applications/:appId/guilds/:guildId/commands/:cmdId`,
        async ({ request, params }) => {
          const body = (await request.json()) as { description?: string };
          return HttpResponse.json({
            id: params.cmdId,
            application_id: params.appId,
            guild_id: params.guildId,
            name: 'pong',
            description: body.description,
            type: 1,
          });
        },
      ),
    );
    const t = new commandsModifyGuild(
      { name: 'commands_modify_guild', path: 'inline', root: 'inline', store: null as never },
      { name: 'commands_modify_guild', enabled: true },
    );
    const r = (await t.run(
      {
        application_id: '111111111111111111',
        guild_id: '999000999000999000',
        command_id: '222222222222222222',
        description: 'updated',
      },
      { signal: new AbortController().signal },
    )) as { isError: boolean; structuredContent: { description?: string } };
    expect(r.isError).toBe(false);
    expect(r.structuredContent.description).toBe('updated');
  });
});
