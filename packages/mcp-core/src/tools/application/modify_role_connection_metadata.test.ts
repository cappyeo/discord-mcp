import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import applicationModifyRoleConnectionMetadata from './modify_role_connection_metadata.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';

describe('application_modify_role_connection_metadata', () => {
  it('PUTs records and returns the updated set', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    server.use(
      http.put(
        `${DISCORD_API}/applications/:appId/role-connections/metadata`,
        async ({ request }) => {
          const body = (await request.json()) as Array<{ key: string; type: number }>;
          return HttpResponse.json(
            body.map((b) => ({ key: b.key, name: b.key, description: b.key, type: b.type })),
          );
        },
      ),
    );
    const t = new applicationModifyRoleConnectionMetadata(
      {
        name: 'application_modify_role_connection_metadata',
        path: 'inline',
        root: 'inline',
        store: null as never,
      },
      { name: 'application_modify_role_connection_metadata', enabled: true },
    );
    const r = (await t.run(
      {
        application_id: '111111111111111111',
        records: [{ key: 'level', name: 'Level', description: 'XP level', type: 2 }],
      },
      { signal: new AbortController().signal },
    )) as { isError: boolean; structuredContent: { count: number } };
    expect(r.isError).toBe(false);
    expect(r.structuredContent.count).toBe(1);
  });
});
