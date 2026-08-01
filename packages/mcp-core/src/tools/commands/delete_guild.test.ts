import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import commandsDeleteGuild from './delete_guild.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';

describe('commands_delete_guild', () => {
  it('DELETEs and returns deleted:true', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    let called = false;
    server.use(
      http.delete(`${DISCORD_API}/applications/:appId/guilds/:guildId/commands/:cmdId`, () => {
        called = true;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const t = new commandsDeleteGuild(
      { name: 'commands_delete_guild', path: 'inline', root: 'inline', store: null as never },
      { name: 'commands_delete_guild', enabled: true },
    );
    const r = (await t.run(
      {
        application_id: '111111111111111111',
        guild_id: '999000999000999000',
        command_id: '222222222222222222',
      },
      { signal: new AbortController().signal },
    )) as { isError: boolean; structuredContent: { deleted: true; command_id: string } };
    expect(called).toBe(true);
    expect(r.isError).toBe(false);
    expect(r.structuredContent.deleted).toBe(true);
  });
});
