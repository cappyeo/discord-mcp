import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import interactionsEditOriginalResponse from './edit_original_response.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';
const TOKEN = 'c'.repeat(70);

describe('interactions_edit_original_response', () => {
  it('PATCHes @original without Authorization header', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    let auth: string | null = 'sentinel';
    server.use(
      http.patch(
        `${DISCORD_API}/webhooks/:appId/:token/messages/:mid`,
        async ({ params, request }) => {
          auth = request.headers.get('authorization');
          expect(decodeURIComponent(params.mid as string)).toBe('@original');
          const body = (await request.json()) as { content?: string };
          return HttpResponse.json({
            id: '999000999000999000',
            channel_id: '111122223333444401',
            content: body.content ?? '',
          });
        },
      ),
    );
    const t = new interactionsEditOriginalResponse(
      {
        name: 'interactions_edit_original_response',
        path: 'inline',
        root: 'inline',
        store: null as never,
      },
      { name: 'interactions_edit_original_response', enabled: true },
    );
    const r = (await t.run(
      {
        application_id: '111111111111111111',
        interaction_token: TOKEN,
        content: 'updated reply',
      },
      { signal: new AbortController().signal },
    )) as { isError: boolean; structuredContent: { message_id: string } };
    expect(auth).toBeNull();
    expect(r.isError).toBe(false);
    expect(r.structuredContent.message_id).toBe('999000999000999000');
  });
});
