import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import interactionsEditFollowup from './edit_followup.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';
const TOKEN = 'g'.repeat(70);

describe('interactions_edit_followup', () => {
  it('PATCHes follow-up message without Authorization header', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    let auth: string | null = 'sentinel';
    server.use(
      http.patch(
        `${DISCORD_API}/webhooks/:appId/:token/messages/:mid`,
        async ({ params, request }) => {
          auth = request.headers.get('authorization');
          return HttpResponse.json({
            id: params.mid,
            channel_id: '111122223333444401',
          });
        },
      ),
    );
    const t = new interactionsEditFollowup(
      { name: 'interactions_edit_followup', path: 'inline', root: 'inline', store: null as never },
      { name: 'interactions_edit_followup', enabled: true },
    );
    const r = (await t.run(
      {
        application_id: '111111111111111111',
        interaction_token: TOKEN,
        message_id: '999000999000999001',
        content: 'edited',
      },
      { signal: new AbortController().signal },
    )) as { isError: boolean; structuredContent: { message_id: string } };
    expect(auth).toBeNull();
    expect(r.isError).toBe(false);
    expect(r.structuredContent.message_id).toBe('999000999000999001');
  });
});
