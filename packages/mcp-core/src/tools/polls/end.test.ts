import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import pollsEnd from './end.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';

describe('polls_end', () => {
  it('POSTs /channels/:cid/polls/:mid/expire', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    server.use(
      http.post(`${DISCORD_API}/channels/:cid/polls/:mid/expire`, () => {
        return HttpResponse.json({ id: '999000999000999000', channel_id: '111122223333444455' });
      }),
    );
    const T = pollsEnd;
    const t = new T(
      { name: 'polls_end', path: 'inline', root: 'inline', store: null as never },
      { name: 'polls_end', enabled: true },
    );
    const r = (await t.run(
      { channel_id: '111122223333444455', message_id: '999000999000999000' },
      { signal: new AbortController().signal },
    )) as { isError: boolean; structuredContent: { ended: boolean } };
    expect(r.isError).toBe(false);
    expect(r.structuredContent.ended).toBe(true);
  });
});
