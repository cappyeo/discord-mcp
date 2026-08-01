import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import invitesListChannel from './list_channel.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';

describe('invites_list_channel', () => {
  it('GETs channel invites and projects each entry', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    server.use(
      http.get(`${DISCORD_API}/channels/:channelId/invites`, () =>
        HttpResponse.json([
          {
            code: 'abc123',
            uses: 5,
            max_uses: 10,
            max_age: 86400,
            temporary: false,
            inviter: { id: '111122223333444401', username: 'alice', global_name: 'Alice' },
          },
          {
            code: 'def456',
            uses: 0,
            max_uses: 0,
            max_age: 0,
            temporary: true,
          },
        ]),
      ),
    );
    const t = new invitesListChannel(
      { name: 'invites_list_channel', path: 'inline', root: 'inline', store: null as never },
      { name: 'invites_list_channel', enabled: true },
    );
    const r = (await t.run(
      { channel_id: '111122223333444402' },
      { signal: new AbortController().signal },
    )) as {
      isError: boolean;
      structuredContent: { invites: Array<{ code: string; inviter_name?: string }> };
    };
    expect(r.isError).toBe(false);
    expect(r.structuredContent.invites).toHaveLength(2);
    expect(r.structuredContent.invites[0]?.code).toBe('abc123');
    expect(r.structuredContent.invites[0]?.inviter_name).toBe('Alice');
    expect(r.structuredContent.invites[1]?.code).toBe('def456');
  });
});
