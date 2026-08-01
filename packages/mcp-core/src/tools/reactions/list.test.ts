import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import reactionsList from './list.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';

describe('reactions_list', () => {
  it('returns the user array from the reaction endpoint', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    server.use(
      http.get(`${DISCORD_API}/channels/:channelId/messages/:messageId/reactions/*`, async () =>
        HttpResponse.json([
          { id: '111122223333444401', username: 'alice', global_name: 'Alice', bot: false },
          { id: '111122223333444402', username: 'bob', bot: false },
        ]),
      ),
    );
    const T = reactionsList;
    const t = new T(
      { name: 'reactions_list', path: 'inline', root: 'inline', store: null as never },
      { name: 'reactions_list', enabled: true },
    );
    const r = (await t.run(
      {
        channel_id: '111122223333444401',
        message_id: '999000999000999000',
        emoji: '👍',
        limit: 25,
      },
      { signal: new AbortController().signal },
    )) as {
      isError: boolean;
      structuredContent: { users: unknown[]; count: number };
    };
    expect(r.isError).toBe(false);
    expect(r.structuredContent.count).toBe(2);
  });
});
