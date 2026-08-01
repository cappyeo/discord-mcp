import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import commandsGetGuild from './get_guild.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';

describe('commands_get_guild', () => {
  it('GETs single guild command', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    server.use(
      http.get(`${DISCORD_API}/applications/:appId/guilds/:guildId/commands/:cmdId`, ({ params }) =>
        HttpResponse.json({
          id: params.cmdId,
          application_id: params.appId,
          guild_id: params.guildId,
          name: 'pong',
          description: 'pong',
          type: 1,
        }),
      ),
    );
    const t = new commandsGetGuild(
      { name: 'commands_get_guild', path: 'inline', root: 'inline', store: null as never },
      { name: 'commands_get_guild', enabled: true },
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
      structuredContent: { name: string; untrusted_text: string };
    };
    expect(r.isError).toBe(false);
    expect(r.structuredContent.name).toBe('pong');
    expect(r.structuredContent.untrusted_text).toContain('untrusted_discord_channel_topic');
  });
});
