import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import eventsDelete from './delete.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';

describe('events_delete', () => {
  it('DELETEs scheduled event and returns deleted:true', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    let called = false;
    server.use(
      http.delete(`${DISCORD_API}/guilds/:guildId/scheduled-events/:eventId`, () => {
        called = true;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const T = eventsDelete;
    const t = new T(
      { name: 'events_delete', path: 'inline', root: 'inline', store: null as never },
      { name: 'events_delete', enabled: true },
    );
    const r = (await t.run(
      {
        guild_id: '999000999000999000',
        event_id: '111122223333444402',
        audit_reason: 'cancelled',
      },
      { signal: new AbortController().signal },
    )) as { isError: boolean; structuredContent: { deleted: true; event_id: string } };
    expect(called).toBe(true);
    expect(r.isError).toBe(false);
    expect(r.structuredContent.deleted).toBe(true);
    expect(r.structuredContent.event_id).toBe('111122223333444402');
  });
});
