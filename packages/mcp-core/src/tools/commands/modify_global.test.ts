import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import commandsModifyGlobal from './modify_global.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';

describe('commands_modify_global', () => {
  it('PATCHes the global command', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    server.use(
      http.patch(
        `${DISCORD_API}/applications/:appId/commands/:cmdId`,
        async ({ request, params }) => {
          const body = (await request.json()) as { description?: string };
          expect(body.description).toBe('updated');
          return HttpResponse.json({
            id: params.cmdId,
            application_id: params.appId,
            name: 'help',
            description: body.description,
            type: 1,
          });
        },
      ),
    );
    const t = new commandsModifyGlobal(
      { name: 'commands_modify_global', path: 'inline', root: 'inline', store: null as never },
      { name: 'commands_modify_global', enabled: true },
    );
    const r = (await t.run(
      {
        application_id: '111111111111111111',
        command_id: '222222222222222222',
        description: 'updated',
      },
      { signal: new AbortController().signal },
    )) as { isError: boolean; structuredContent: { description?: string } };
    expect(r.isError).toBe(false);
    expect(r.structuredContent.description).toBe('updated');
  });
});
