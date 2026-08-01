import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import webhooksModifyWithToken from './modify_with_token.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';
const TOKEN = 'a'.repeat(70);

describe('webhooks_modify_with_token', () => {
  it('PATCHes without Authorization header', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    server.use(
      http.patch(`${DISCORD_API}/webhooks/:wid/:token`, async ({ request, params }) => {
        expect(request.headers.get('authorization')).toBeNull();
        const body = (await request.json()) as { name?: string };
        return HttpResponse.json({
          id: params.wid,
          type: 1,
          name: body.name ?? 'CI',
          avatar: null,
          channel_id: '111122223333444455',
          application_id: null,
        });
      }),
    );
    const T = webhooksModifyWithToken;
    const t = new T(
      { name: 'webhooks_modify_with_token', path: 'inline', root: 'inline', store: null as never },
      { name: 'webhooks_modify_with_token', enabled: true },
    );
    const r = (await t.run(
      { webhook_id: '111122223333444455', token: TOKEN, name: 'New' },
      { signal: new AbortController().signal },
    )) as { isError: boolean; structuredContent: { name: string | null; untrusted_name: string } };
    expect(r.isError).toBe(false);
    expect(r.structuredContent.name).toBe('New');
    expect(r.structuredContent.untrusted_name).toContain('untrusted_discord_username');
  });
});
