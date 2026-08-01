import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import reactionsCreate from './create.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';

describe('reactions_create', () => {
  it('PUTs the @me reaction route and returns reacted:true', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    server.use(
      // Wide wildcard matcher: emoji segment is percent-encoded by @discordjs/rest.
      http.put(
        `${DISCORD_API}/channels/:channelId/messages/:messageId/reactions/*`,
        async () => new HttpResponse(null, { status: 204 }),
      ),
    );
    const T = reactionsCreate;
    const t = new T(
      { name: 'reactions_create', path: 'inline', root: 'inline', store: null as never },
      { name: 'reactions_create', enabled: true },
    );
    const r = (await t.run(
      {
        channel_id: '111122223333444401',
        message_id: '999000999000999000',
        emoji: 'thumbsup:850000000000000001',
      },
      { signal: new AbortController().signal },
    )) as { isError: boolean; structuredContent: { reacted: boolean; emoji: string } };
    expect(r.isError).toBe(false);
    expect(r.structuredContent.reacted).toBe(true);
    expect(r.structuredContent.emoji).toBe('thumbsup:850000000000000001');
  });
});
