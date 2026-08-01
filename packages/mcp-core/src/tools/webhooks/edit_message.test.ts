import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import webhooksEditMessage from './edit_message.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';
const TOKEN = 'a'.repeat(70);

describe('webhooks_edit_message', () => {
  it('PATCHes without Authorization header and returns the new message_id', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    server.use(
      http.patch(
        `${DISCORD_API}/webhooks/:wid/:token/messages/:mid`,
        async ({ request, params }) => {
          expect(request.headers.get('authorization')).toBeNull();
          const body = (await request.json()) as { content?: string };
          expect(body.content).toBe('updated');
          return HttpResponse.json({
            id: params.mid,
            channel_id: '111122223333444455',
          });
        },
      ),
    );
    const T = webhooksEditMessage;
    const t = new T(
      { name: 'webhooks_edit_message', path: 'inline', root: 'inline', store: null as never },
      { name: 'webhooks_edit_message', enabled: true },
    );
    const r = (await t.run(
      {
        webhook_id: '111122223333444455',
        token: TOKEN,
        message_id: '999000999000999000',
        content: 'updated',
      },
      { signal: new AbortController().signal },
    )) as { isError: boolean; structuredContent: { message_id: string } };
    expect(r.isError).toBe(false);
    expect(r.structuredContent.message_id).toBe('999000999000999000');
  });
});
