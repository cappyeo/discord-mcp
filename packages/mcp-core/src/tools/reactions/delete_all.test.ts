import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import reactionsDeleteAll from './delete_all.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';

describe('reactions_delete_all', () => {
  it('clears all reactions when no emoji is given', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    server.use(
      http.delete(
        `${DISCORD_API}/channels/:channelId/messages/:messageId/reactions`,
        async () => new HttpResponse(null, { status: 204 }),
      ),
    );
    const T = reactionsDeleteAll;
    const t = new T(
      { name: 'reactions_delete_all', path: 'inline', root: 'inline', store: null as never },
      { name: 'reactions_delete_all', enabled: true },
    );
    const r = (await t.run(
      { channel_id: '111122223333444401', message_id: '999000999000999000' },
      { signal: new AbortController().signal },
    )) as { isError: boolean; structuredContent: { scope: string; deleted: boolean } };
    expect(r.isError).toBe(false);
    expect(r.structuredContent.scope).toBe('all');
    expect(r.structuredContent.deleted).toBe(true);
  });

  it('clears just the given emoji when provided', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    server.use(
      http.delete(
        `${DISCORD_API}/channels/:channelId/messages/:messageId/reactions/*`,
        async () => new HttpResponse(null, { status: 204 }),
      ),
    );
    const T = reactionsDeleteAll;
    const t = new T(
      { name: 'reactions_delete_all', path: 'inline', root: 'inline', store: null as never },
      { name: 'reactions_delete_all', enabled: true },
    );
    const r = (await t.run(
      { channel_id: '111122223333444401', message_id: '999000999000999000', emoji: '👍' },
      { signal: new AbortController().signal },
    )) as { isError: boolean; structuredContent: { scope: string } };
    expect(r.isError).toBe(false);
    expect(r.structuredContent.scope).toBe('emoji');
  });
});
