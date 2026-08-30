import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import messagesListPins from './list_pins.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';

describe('messages_list_pins', () => {
  it('GETs the paginated pins route and returns continuation metadata', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    const before = '2026-04-29T12:00:00.000Z';
    server.use(
      http.get(`${DISCORD_API}/channels/:channelId/messages/pins`, ({ request, params }) => {
        const url = new URL(request.url);
        expect(params.channelId).toBe('111122223333444401');
        expect(url.searchParams.get('limit')).toBe('2');
        expect(url.searchParams.get('before')).toBe(before);
        return HttpResponse.json({
          has_more: true,
          items: [
            {
              pinned_at: '2026-04-28T12:00:00.000Z',
              message: {
                id: '999000999000999001',
                channel_id: params.channelId,
                content: 'pinned welcome',
                author: { id: '111122223333444401', username: 'bot', global_name: 'Bot' },
                timestamp: '2026-04-28T11:00:00.000Z',
              },
            },
          ],
        });
      }),
    );
    const T = messagesListPins;
    const t = new T(
      { name: 'messages_list_pins', path: 'inline', root: 'inline', store: null as never },
      { name: 'messages_list_pins', enabled: true },
    );
    const r = (await t.run(
      { channel_id: '111122223333444401', before, limit: 2 },
      { signal: new AbortController().signal },
    )) as {
      isError: boolean;
      content: Array<{ text: string }>;
      structuredContent: {
        pins: Array<{ pinned_at: string }>;
        count: number;
        has_more: boolean;
        next_before?: string;
      };
    };
    expect(r.isError).toBe(false);
    expect(r.structuredContent.count).toBe(1);
    expect(r.structuredContent.has_more).toBe(true);
    expect(r.structuredContent.pins[0]?.pinned_at).toBe('2026-04-28T12:00:00.000Z');
    expect(r.structuredContent.next_before).toBe('2026-04-28T12:00:00.000Z');
    expect(r.content[0]?.text).toMatch(/<untrusted_discord_messages/);
  });

  it('omits next_before for an empty page', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    server.use(
      http.get(`${DISCORD_API}/channels/:channelId/messages/pins`, ({ request }) => {
        const url = new URL(request.url);
        expect(Object.fromEntries(url.searchParams)).toEqual({ limit: '50' });
        return HttpResponse.json({ items: [], has_more: false });
      }),
    );
    const T = messagesListPins;
    const t = new T(
      { name: 'messages_list_pins', path: 'inline', root: 'inline', store: null as never },
      { name: 'messages_list_pins', enabled: true },
    );
    const r = (await t.run(
      { channel_id: '111122223333444401' },
      { signal: new AbortController().signal },
    )) as { structuredContent: { has_more: boolean; next_before?: string } };
    expect(r.structuredContent.has_more).toBe(false);
    expect(r.structuredContent.next_before).toBeUndefined();
  });
});
