import { server } from '@cappyeo/discord-mcp-server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import channelsListActiveThreadsGuild from './list_active_threads_guild.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';

describe('channels_list_active_threads_guild', () => {
  it('GETs active threads and projects + wraps names', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    server.use(
      http.get(`${DISCORD_API}/guilds/:guildId/threads/active`, async () =>
        HttpResponse.json({
          threads: [
            {
              id: '999000999000999301',
              name: 'release v2 chat',
              type: 11,
              parent_id: '111122223333444401',
              owner_id: '537711014240270104',
              thread_metadata: { archived: false, locked: false },
            },
          ],
          members: [],
        }),
      ),
    );
    const T = channelsListActiveThreadsGuild;
    const t = new T(
      {
        name: 'channels_list_active_threads_guild',
        path: 'inline',
        root: 'inline',
        store: null as never,
      },
      { name: 'channels_list_active_threads_guild', enabled: true },
    );
    const r = (await t.run(
      { guild_id: '999000999000999000' },
      { signal: new AbortController().signal },
    )) as {
      isError: boolean;
      content: Array<{ type: string; text: string }>;
      structuredContent: { count: number; threads: Array<{ id: string }> };
    };
    expect(r.isError).toBe(false);
    expect(r.structuredContent.count).toBe(1);
    expect(r.structuredContent.threads[0]!.id).toBe('999000999000999301');
    expect(r.content[0]!.text).toContain('untrusted_discord_message');
  });
});
