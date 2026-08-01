import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import channelsModifyPermissions from './modify_permissions.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';

describe('channels_modify_permissions', () => {
  it('PUTs the overwrite body and returns updated:true', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    let receivedBody: unknown = null;
    server.use(
      http.put(
        `${DISCORD_API}/channels/:channelId/permissions/:overwriteId`,
        async ({ request }) => {
          receivedBody = await request.json();
          return new HttpResponse(null, { status: 204 });
        },
      ),
    );
    const T = channelsModifyPermissions;
    const t = new T(
      {
        name: 'channels_modify_permissions',
        path: 'inline',
        root: 'inline',
        store: null as never,
      },
      { name: 'channels_modify_permissions', enabled: true },
    );
    const r = (await t.run(
      {
        channel_id: '111122223333444401',
        overwrite_id: '999000999000999111',
        type: 0,
        allow: '1024',
        deny: '0',
      },
      { signal: new AbortController().signal },
    )) as { isError: boolean; structuredContent: { updated: boolean } };
    expect(r.isError).toBe(false);
    expect(r.structuredContent.updated).toBe(true);
    expect(receivedBody).toMatchObject({ type: 0, allow: '1024', deny: '0' });
  });
});
