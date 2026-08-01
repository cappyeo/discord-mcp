import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import eventsModify from './modify.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';

describe('events_modify', () => {
  it('PATCHes scheduled event and wraps name/description in response', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    server.use(
      http.patch(
        `${DISCORD_API}/guilds/:guildId/scheduled-events/:eventId`,
        async ({ request, params }) => {
          const body = (await request.json()) as Record<string, unknown>;
          expect(body.status).toBe(4);
          return HttpResponse.json({
            id: params.eventId,
            guild_id: params.guildId,
            name: 'Office Hours',
            description: 'updated',
            scheduled_start_time: '2026-05-01T15:00:00Z',
            scheduled_end_time: null,
            status: 4,
            entity_type: 2,
            channel_id: '111122223333444401',
            creator_id: '111122223333444499',
            entity_metadata: { location: null },
          });
        },
      ),
    );
    const T = eventsModify;
    const t = new T(
      { name: 'events_modify', path: 'inline', root: 'inline', store: null as never },
      { name: 'events_modify', enabled: true },
    );
    const r = (await t.run(
      { guild_id: '999000999000999000', event_id: '111122223333444402', status: 4 },
      { signal: new AbortController().signal },
    )) as {
      isError: boolean;
      structuredContent: { id: string; status: number; untrusted_text: string };
    };
    expect(r.isError).toBe(false);
    expect(r.structuredContent.status).toBe(4);
    expect(r.structuredContent.untrusted_text).toContain('untrusted_discord_channel_topic');
    expect(r.structuredContent.untrusted_text).toContain('Office Hours');
  });
});
