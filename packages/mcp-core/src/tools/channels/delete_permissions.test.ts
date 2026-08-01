import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import channelsDeletePermissions from './delete_permissions.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';

describe('channels_delete_permissions', () => {
  it('DELETEs the overwrite and returns deleted:true', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    server.use(
      http.delete(
        `${DISCORD_API}/channels/:channelId/permissions/:overwriteId`,
        async () => new HttpResponse(null, { status: 204 }),
      ),
    );
    const T = channelsDeletePermissions;
    const t = new T(
      {
        name: 'channels_delete_permissions',
        path: 'inline',
        root: 'inline',
        store: null as never,
      },
      { name: 'channels_delete_permissions', enabled: true },
    );
    const r = (await t.run(
      { channel_id: '111122223333444401', overwrite_id: '999000999000999111' },
      { signal: new AbortController().signal },
    )) as { isError: boolean; structuredContent: { deleted: boolean } };
    expect(r.isError).toBe(false);
    expect(r.structuredContent.deleted).toBe(true);
  });
});
