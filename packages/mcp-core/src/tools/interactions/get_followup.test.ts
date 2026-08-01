import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import interactionsGetFollowup from './get_followup.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';
const TOKEN = 'f'.repeat(70);

describe('interactions_get_followup', () => {
  it('GETs follow-up message and wraps content', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    let auth: string | null = 'sentinel';
    server.use(
      http.get(`${DISCORD_API}/webhooks/:appId/:token/messages/:mid`, ({ params, request }) => {
        auth = request.headers.get('authorization');
        return HttpResponse.json({
          id: params.mid,
          channel_id: '111122223333444401',
          content: 'follow up content',
          author: { id: '111', username: 'bot', global_name: null },
        });
      }),
    );
    const t = new interactionsGetFollowup(
      { name: 'interactions_get_followup', path: 'inline', root: 'inline', store: null as never },
      { name: 'interactions_get_followup', enabled: true },
    );
    const r = (await t.run(
      {
        application_id: '111111111111111111',
        interaction_token: TOKEN,
        message_id: '999000999000999001',
      },
      { signal: new AbortController().signal },
    )) as { isError: boolean; structuredContent: { untrusted_messages: string } };
    expect(auth).toBeNull();
    expect(r.isError).toBe(false);
    expect(r.structuredContent.untrusted_messages).toContain('untrusted_discord_messages');
  });
});
