import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import commandsDeleteGlobal from './delete_global.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';

describe('commands_delete_global', () => {
  it('DELETEs and returns deleted:true', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    let called = false;
    server.use(
      http.delete(`${DISCORD_API}/applications/:appId/commands/:cmdId`, () => {
        called = true;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const t = new commandsDeleteGlobal(
      { name: 'commands_delete_global', path: 'inline', root: 'inline', store: null as never },
      { name: 'commands_delete_global', enabled: true },
    );
    const r = (await t.run(
      { application_id: '111111111111111111', command_id: '222222222222222222' },
      { signal: new AbortController().signal },
    )) as { isError: boolean; structuredContent: { deleted: true; command_id: string } };
    expect(called).toBe(true);
    expect(r.isError).toBe(false);
    expect(r.structuredContent.deleted).toBe(true);
  });
});
