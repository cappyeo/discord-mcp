import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import webhooksGetWithToken from './get_with_token.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';
const TOKEN = 'a'.repeat(70);

describe('webhooks_get_with_token', () => {
  it('GETs without sending Authorization header', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    server.use(
      http.get(`${DISCORD_API}/webhooks/:wid/:token`, ({ request, params }) => {
        expect(request.headers.get('authorization')).toBeNull();
        return HttpResponse.json({
          id: params.wid,
          type: 1,
          name: 'CI',
          avatar: null,
          channel_id: '111122223333444455',
          application_id: null,
          token: TOKEN,
        });
      }),
    );
    const T = webhooksGetWithToken;
    const t = new T(
      { name: 'webhooks_get_with_token', path: 'inline', root: 'inline', store: null as never },
      { name: 'webhooks_get_with_token', enabled: true },
    );
    const r = (await t.run(
      { webhook_id: '111122223333444455', token: TOKEN },
      { signal: new AbortController().signal },
    )) as {
      isError: boolean;
      structuredContent: { id: string; token?: string; untrusted_name: string };
    };
    expect(r.isError).toBe(false);
    expect(r.structuredContent.token).toBe(TOKEN);
    expect(r.structuredContent.untrusted_name).toContain('untrusted_discord_username');
  });
});
