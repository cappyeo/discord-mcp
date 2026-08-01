import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import channelsDelete from './delete.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';

describe('channels_delete', () => {
  it('DELETEs the channel and returns deleted:true', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    server.use(
      http.delete(
        `${DISCORD_API}/channels/:channelId`,
        async () => new HttpResponse(null, { status: 204 }),
      ),
    );
    const T = channelsDelete;
    const t = new T(
      { name: 'channels_delete', path: 'inline', root: 'inline', store: null as never },
      { name: 'channels_delete', enabled: true },
    );
    const r = (await t.run(
      { channel_id: '111122223333444401' },
      { signal: new AbortController().signal },
    )) as { isError: boolean; structuredContent: { deleted: boolean } };
    expect(r.isError).toBe(false);
    expect(r.structuredContent.deleted).toBe(true);
  });

  it('declares confirm_required and destructiveHint', () => {
    const T = channelsDelete;
    const t = new T(
      { name: 'channels_delete', path: 'inline', root: 'inline', store: null as never },
      { name: 'channels_delete', enabled: true },
    );
    expect(t.preconditions).toContain('confirm_required');
    expect(t.annotations.destructiveHint).toBe(true);
  });
});
