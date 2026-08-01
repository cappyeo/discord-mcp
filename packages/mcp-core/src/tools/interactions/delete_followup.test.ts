import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import interactionsDeleteFollowup from './delete_followup.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';
const TOKEN = 'h'.repeat(70);

describe('interactions_delete_followup', () => {
  it('DELETEs follow-up message without Authorization header', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    let auth: string | null = 'sentinel';
    server.use(
      http.delete(`${DISCORD_API}/webhooks/:appId/:token/messages/:mid`, ({ request }) => {
        auth = request.headers.get('authorization');
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const t = new interactionsDeleteFollowup(
      {
        name: 'interactions_delete_followup',
        path: 'inline',
        root: 'inline',
        store: null as never,
      },
      { name: 'interactions_delete_followup', enabled: true },
    );
    const r = (await t.run(
      {
        application_id: '111111111111111111',
        interaction_token: TOKEN,
        message_id: '999000999000999001',
      },
      { signal: new AbortController().signal },
    )) as { isError: boolean; structuredContent: { deleted: true; message_id: string } };
    expect(auth).toBeNull();
    expect(r.isError).toBe(false);
    expect(r.structuredContent.deleted).toBe(true);
  });
});
