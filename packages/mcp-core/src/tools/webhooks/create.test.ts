import { server } from '@cappyeo/discord-mcp-server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import webhooksCreate from './create.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';

describe('webhooks_create', () => {
  it('POSTs the channel webhook and returns the token', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    server.use(
      http.post(`${DISCORD_API}/channels/:cid/webhooks`, async ({ request, params }) => {
        const body = (await request.json()) as { name: string };
        expect(body.name).toBe('CI');
        return HttpResponse.json({
          id: '164383424266383145',
          type: 1,
          name: body.name,
          avatar: null,
          channel_id: params.cid,
          application_id: null,
          token: 'a'.repeat(70),
        });
      }),
    );
    const T = webhooksCreate;
    const t = new T(
      { name: 'webhooks_create', path: 'inline', root: 'inline', store: null as never },
      { name: 'webhooks_create', enabled: true },
    );
    const r = (await t.run(
      { channel_id: '111122223333444455', name: 'CI' },
      { signal: new AbortController().signal },
    )) as {
      isError: boolean;
      structuredContent: { id: string; token?: string; untrusted_name: string };
    };
    expect(r.isError).toBe(false);
    expect(r.structuredContent.id).toBe('164383424266383145');
    expect(r.structuredContent.token).toBe('a'.repeat(70));
    expect(r.structuredContent.untrusted_name).toContain('untrusted_discord_username');
  });
});
