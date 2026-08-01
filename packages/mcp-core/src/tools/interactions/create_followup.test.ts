import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import interactionsCreateFollowup from './create_followup.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';
const TOKEN = 'e'.repeat(70);

describe('interactions_create_followup', () => {
  it('POSTs follow-up with ephemeral flag, no Authorization header', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    let auth: string | null = 'sentinel';
    let receivedFlags: number | undefined;
    server.use(
      http.post(`${DISCORD_API}/webhooks/:appId/:token`, async ({ request }) => {
        auth = request.headers.get('authorization');
        const body = (await request.json()) as { flags?: number };
        receivedFlags = body.flags;
        return HttpResponse.json({
          id: '999000999000999001',
          channel_id: '111122223333444401',
        });
      }),
    );
    const t = new interactionsCreateFollowup(
      {
        name: 'interactions_create_followup',
        path: 'inline',
        root: 'inline',
        store: null as never,
      },
      { name: 'interactions_create_followup', enabled: true },
    );
    const r = (await t.run(
      {
        application_id: '111111111111111111',
        interaction_token: TOKEN,
        content: 'follow',
        ephemeral: true,
      },
      { signal: new AbortController().signal },
    )) as { isError: boolean; structuredContent: { message_id: string } };
    expect(auth).toBeNull();
    expect(receivedFlags).toBe(64);
    expect(r.isError).toBe(false);
    expect(r.structuredContent.message_id).toBe('999000999000999001');
  });
});
