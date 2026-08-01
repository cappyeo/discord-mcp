import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import commandsCreateGlobal from './create_global.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';

describe('commands_create_global', () => {
  it('POSTs body and returns the created command', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    server.use(
      http.post(`${DISCORD_API}/applications/:appId/commands`, async ({ request, params }) => {
        const body = (await request.json()) as { name: string; description?: string };
        expect(body.name).toBe('greet');
        return HttpResponse.json({
          id: 'cmd_new_1',
          application_id: params.appId,
          name: body.name,
          description: body.description ?? '',
          type: 1,
        });
      }),
    );
    const t = new commandsCreateGlobal(
      { name: 'commands_create_global', path: 'inline', root: 'inline', store: null as never },
      { name: 'commands_create_global', enabled: true },
    );
    const r = (await t.run(
      { application_id: '111111111111111111', name: 'greet', description: 'say hi' },
      { signal: new AbortController().signal },
    )) as { isError: boolean; structuredContent: { id: string; name: string } };
    expect(r.isError).toBe(false);
    expect(r.structuredContent.id).toBe('cmd_new_1');
    expect(r.structuredContent.name).toBe('greet');
  });
});
