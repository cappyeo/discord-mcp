import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import webhooksDeleteMessage from './delete_message.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';
const TOKEN = 'a'.repeat(70);

describe('webhooks_delete_message', () => {
  it('DELETEs without Authorization header', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    let called = false;
    server.use(
      http.delete(`${DISCORD_API}/webhooks/:wid/:token/messages/:mid`, ({ request }) => {
        expect(request.headers.get('authorization')).toBeNull();
        called = true;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const T = webhooksDeleteMessage;
    const t = new T(
      { name: 'webhooks_delete_message', path: 'inline', root: 'inline', store: null as never },
      { name: 'webhooks_delete_message', enabled: true },
    );
    const r = (await t.run(
      { webhook_id: '111122223333444455', token: TOKEN, message_id: '999000999000999000' },
      { signal: new AbortController().signal },
    )) as { isError: boolean; structuredContent: { deleted: true; message_id: string } };
    expect(called).toBe(true);
    expect(r.isError).toBe(false);
    expect(r.structuredContent.deleted).toBe(true);
  });
});
