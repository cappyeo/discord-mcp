import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import commandsBulkOverwriteGlobal from './bulk_overwrite_global.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';

describe('commands_bulk_overwrite_global', () => {
  it('PUTs the full command array', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    server.use(
      http.put(`${DISCORD_API}/applications/:appId/commands`, async ({ request }) => {
        const body = (await request.json()) as Array<{ name: string }>;
        expect(body).toHaveLength(2);
        return HttpResponse.json([
          { id: 'cmd_b1', name: body[0]!.name, type: 1 },
          { id: 'cmd_b2', name: body[1]!.name, type: 1 },
        ]);
      }),
    );
    const t = new commandsBulkOverwriteGlobal(
      {
        name: 'commands_bulk_overwrite_global',
        path: 'inline',
        root: 'inline',
        store: null as never,
      },
      { name: 'commands_bulk_overwrite_global', enabled: true },
    );
    const r = (await t.run(
      {
        application_id: '111111111111111111',
        commands: [
          { name: 'a', description: 'a' },
          { name: 'b', description: 'b' },
        ],
      },
      { signal: new AbortController().signal },
    )) as { isError: boolean; structuredContent: { count: number } };
    expect(r.isError).toBe(false);
    expect(r.structuredContent.count).toBe(2);
  });
});
