import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import channelsCreateGuildChannel from './create_guild_channel.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';

describe('channels_create_guild_channel', () => {
  it('POSTs the channel body and returns id+name+type+parent_id', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    let receivedBody: unknown = null;
    server.use(
      http.post(`${DISCORD_API}/guilds/:guildId/channels`, async ({ request }) => {
        receivedBody = await request.json();
        return HttpResponse.json({
          id: '111122223333444466',
          name: 'announcements',
          type: 5,
          parent_id: null,
        });
      }),
    );
    const T = channelsCreateGuildChannel;
    const t = new T(
      {
        name: 'channels_create_guild_channel',
        path: 'inline',
        root: 'inline',
        store: null as never,
      },
      { name: 'channels_create_guild_channel', enabled: true },
    );
    const r = (await t.run(
      { guild_id: '999000999000999000', name: 'announcements', type: 5 },
      { signal: new AbortController().signal },
    )) as {
      isError: boolean;
      structuredContent: { id: string; name: string; type: number };
    };
    expect(r.isError).toBe(false);
    expect(r.structuredContent.id).toBe('111122223333444466');
    expect(r.structuredContent.type).toBe(5);
    expect(receivedBody).toMatchObject({ name: 'announcements', type: 5 });
  });
});
