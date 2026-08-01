import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import interactionsDeleteOriginalResponse from './delete_original_response.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';
const TOKEN = 'd'.repeat(70);

describe('interactions_delete_original_response', () => {
  it('DELETEs @original without Authorization header', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    let auth: string | null = 'sentinel';
    server.use(
      http.delete(`${DISCORD_API}/webhooks/:appId/:token/messages/:mid`, ({ params, request }) => {
        auth = request.headers.get('authorization');
        expect(decodeURIComponent(params.mid as string)).toBe('@original');
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const t = new interactionsDeleteOriginalResponse(
      {
        name: 'interactions_delete_original_response',
        path: 'inline',
        root: 'inline',
        store: null as never,
      },
      { name: 'interactions_delete_original_response', enabled: true },
    );
    const r = (await t.run(
      { application_id: '111111111111111111', interaction_token: TOKEN },
      { signal: new AbortController().signal },
    )) as { isError: boolean; structuredContent: { deleted: true } };
    expect(auth).toBeNull();
    expect(r.isError).toBe(false);
    expect(r.structuredContent.deleted).toBe(true);
  });
});
