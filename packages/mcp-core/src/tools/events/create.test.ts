import { server } from '@cappyeo/discord-mcp-server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import eventsCreate from './create.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';

describe('events_create', () => {
  it('POSTs scheduled event and returns its id', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    server.use(
      http.post(`${DISCORD_API}/guilds/:guildId/scheduled-events`, async ({ request, params }) => {
        const body = (await request.json()) as Record<string, unknown>;
        expect(body.name).toBe('Office Hours');
        expect(body.entity_type).toBe(2);
        expect(body.privacy_level).toBe(2);
        return HttpResponse.json({
          id: '762014852510723514',
          guild_id: params.guildId,
          name: body.name,
          description: null,
          scheduled_start_time: body.scheduled_start_time,
          scheduled_end_time: null,
          status: 1,
          entity_type: body.entity_type,
          channel_id: body.channel_id ?? null,
          creator_id: '394302850041909017',
        });
      }),
    );
    const T = eventsCreate;
    const t = new T(
      { name: 'events_create', path: 'inline', root: 'inline', store: null as never },
      { name: 'events_create', enabled: true },
    );
    const r = (await t.run(
      {
        guild_id: '999000999000999000',
        name: 'Office Hours',
        scheduled_start_time: '2026-05-01T15:00:00Z',
        entity_type: 2,
        channel_id: '111122223333444401',
      },
      { signal: new AbortController().signal },
    )) as {
      isError: boolean;
      structuredContent: { id: string; name: string };
    };
    expect(r.isError).toBe(false);
    expect(r.structuredContent.id).toBe('762014852510723514');
    expect(r.structuredContent.name).toBe('Office Hours');
  });
});
