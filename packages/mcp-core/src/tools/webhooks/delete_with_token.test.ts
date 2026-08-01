import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import webhooksDeleteWithToken from './delete_with_token.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';
const TOKEN = 'a'.repeat(70);

describe('webhooks_delete_with_token', () => {
  it('DELETEs without Authorization header', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    let called = false;
    server.use(
      http.delete(`${DISCORD_API}/webhooks/:wid/:token`, ({ request }) => {
        expect(request.headers.get('authorization')).toBeNull();
        called = true;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const T = webhooksDeleteWithToken;
    const t = new T(
      { name: 'webhooks_delete_with_token', path: 'inline', root: 'inline', store: null as never },
      { name: 'webhooks_delete_with_token', enabled: true },
    );
    const r = (await t.run(
      { webhook_id: '111122223333444455', token: TOKEN },
      { signal: new AbortController().signal },
    )) as { isError: boolean; structuredContent: { deleted: true; webhook_id: string } };
    expect(called).toBe(true);
    expect(r.isError).toBe(false);
    expect(r.structuredContent.deleted).toBe(true);
  });
});
