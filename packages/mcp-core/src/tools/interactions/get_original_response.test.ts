import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import interactionsGetOriginalResponse from './get_original_response.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';
const TOKEN = 'b'.repeat(70);

describe('interactions_get_original_response', () => {
  it('GETs @original with no Authorization header and wraps content', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    let auth: string | null = 'sentinel';
    let url = '';
    server.use(
      // Discord serializes "@original" in the URL path. Capture both forms with a wildcard.
      http.get(`${DISCORD_API}/webhooks/:appId/:token/messages/:mid`, ({ request, params }) => {
        auth = request.headers.get('authorization');
        url = request.url;
        expect(decodeURIComponent(params.mid as string)).toBe('@original');
        return HttpResponse.json({
          id: '999000999000999000',
          channel_id: '111122223333444401',
          content: 'original interaction reply',
          author: { id: '111', username: 'bot', global_name: 'Bot' },
        });
      }),
    );
    const t = new interactionsGetOriginalResponse(
      {
        name: 'interactions_get_original_response',
        path: 'inline',
        root: 'inline',
        store: null as never,
      },
      { name: 'interactions_get_original_response', enabled: true },
    );
    const r = (await t.run(
      { application_id: '111111111111111111', interaction_token: TOKEN },
      { signal: new AbortController().signal },
    )) as {
      isError: boolean;
      structuredContent: { message_id: string; untrusted_messages: string };
    };
    expect(auth).toBeNull();
    expect(url).toMatch(/\/messages\/(?:@original|%40original)/);
    expect(r.isError).toBe(false);
    expect(r.structuredContent.message_id).toBe('999000999000999000');
    expect(r.structuredContent.untrusted_messages).toContain('untrusted_discord_messages');
  });
});
