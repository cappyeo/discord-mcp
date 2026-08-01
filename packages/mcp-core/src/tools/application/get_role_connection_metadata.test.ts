import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import applicationGetRoleConnectionMetadata from './get_role_connection_metadata.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';

describe('application_get_role_connection_metadata', () => {
  it('GETs role-connection metadata records', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    server.use(
      http.get(`${DISCORD_API}/applications/:appId/role-connections/metadata`, () =>
        HttpResponse.json([{ key: 'level', name: 'Level', description: 'XP level', type: 2 }]),
      ),
    );
    const t = new applicationGetRoleConnectionMetadata(
      {
        name: 'application_get_role_connection_metadata',
        path: 'inline',
        root: 'inline',
        store: null as never,
      },
      { name: 'application_get_role_connection_metadata', enabled: true },
    );
    const r = (await t.run(
      { application_id: '111111111111111111' },
      { signal: new AbortController().signal },
    )) as { isError: boolean; structuredContent: { count: number } };
    expect(r.isError).toBe(false);
    expect(r.structuredContent.count).toBe(1);
  });
});
