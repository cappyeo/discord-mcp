import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import pollsGetVoters from './get_voters.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';

describe('polls_get_voters', () => {
  it('GETs poll answers voters and wraps usernames', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    server.use(
      http.get(`${DISCORD_API}/channels/:cid/polls/:mid/answers/:aid`, () => {
        return HttpResponse.json({
          users: [
            {
              id: '111111111111111111',
              username: 'alice',
              discriminator: '0',
              global_name: 'Alice',
            },
          ],
        });
      }),
    );
    const T = pollsGetVoters;
    const t = new T(
      { name: 'polls_get_voters', path: 'inline', root: 'inline', store: null as never },
      { name: 'polls_get_voters', enabled: true },
    );
    const r = (await t.run(
      {
        channel_id: '111122223333444455',
        message_id: '999000999000999000',
        answer_id: 1,
      },
      { signal: new AbortController().signal },
    )) as {
      isError: boolean;
      structuredContent: { count: number; untrusted_text: string };
    };
    expect(r.isError).toBe(false);
    expect(r.structuredContent.count).toBe(1);
    expect(r.structuredContent.untrusted_text).toContain('untrusted_discord_username');
    expect(r.structuredContent.untrusted_text).toContain('alice');
  });
});
