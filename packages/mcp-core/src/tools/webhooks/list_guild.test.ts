import { server } from '@cappyeo/discord-mcp-server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import webhooksListGuild from './list_guild.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';

describe('webhooks_list_guild', () => {
  it('lists guild webhooks', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    server.use(
      http.get(`${DISCORD_API}/guilds/:gid/webhooks`, () => {
        return HttpResponse.json([
          {
            id: '164383424266383145',
            type: 1,
            name: 'CI Notifier',
            avatar: null,
            channel_id: '111122223333444455',
            application_id: null,
          },
          {
            id: '471186398113900843',
            type: 1,
            name: 'Cross-poster',
            avatar: null,
            channel_id: '111122223333444456',
            application_id: null,
          },
        ]);
      }),
    );
    const T = webhooksListGuild;
    const t = new T(
      { name: 'webhooks_list_guild', path: 'inline', root: 'inline', store: null as never },
      { name: 'webhooks_list_guild', enabled: true },
    );
    const r = (await t.run(
      { guild_id: '999000999000999000' },
      { signal: new AbortController().signal },
    )) as {
      isError: boolean;
      structuredContent: { webhooks: Array<{ id: string }>; count: number };
    };
    expect(r.isError).toBe(false);
    expect(r.structuredContent.count).toBe(2);
    expect(r.structuredContent.webhooks[0]!.id).toBe('164383424266383145');
  });
});
