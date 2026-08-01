import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import webhooksExecute from './execute.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';
const TOKEN = 'a'.repeat(70);

describe('webhooks_execute', () => {
  it('POSTs without Authorization header and returns enqueued:true when wait omitted', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    let called = false;
    server.use(
      http.post(`${DISCORD_API}/webhooks/:wid/:token`, async ({ request }) => {
        expect(request.headers.get('authorization')).toBeNull();
        const body = (await request.json()) as { content?: string };
        expect(body.content).toBe('hi');
        called = true;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const T = webhooksExecute;
    const t = new T(
      { name: 'webhooks_execute', path: 'inline', root: 'inline', store: null as never },
      { name: 'webhooks_execute', enabled: true },
    );
    const r = (await t.run(
      { webhook_id: '111122223333444455', token: TOKEN, content: 'hi' },
      { signal: new AbortController().signal },
    )) as { isError: boolean; structuredContent: { enqueued?: boolean; message_id?: string } };
    expect(called).toBe(true);
    expect(r.isError).toBe(false);
    expect(r.structuredContent.enqueued).toBe(true);
  });

  it('returns message_id when wait:true', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    server.use(
      http.post(`${DISCORD_API}/webhooks/:wid/:token`, ({ request }) => {
        const url = new URL(request.url);
        expect(url.searchParams.get('wait')).toBe('true');
        return HttpResponse.json({
          id: '999000999000999000',
          channel_id: '111122223333444455',
          webhook_id: '111122223333444455',
        });
      }),
    );
    const T = webhooksExecute;
    const t = new T(
      { name: 'webhooks_execute', path: 'inline', root: 'inline', store: null as never },
      { name: 'webhooks_execute', enabled: true },
    );
    const r = (await t.run(
      { webhook_id: '111122223333444455', token: TOKEN, content: 'hi', wait: true },
      { signal: new AbortController().signal },
    )) as { isError: boolean; structuredContent: { message_id?: string } };
    expect(r.isError).toBe(false);
    expect(r.structuredContent.message_id).toBe('999000999000999000');
  });

  it('rejects when no payload field provided', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    const T = webhooksExecute;
    const t = new T(
      { name: 'webhooks_execute', path: 'inline', root: 'inline', store: null as never },
      { name: 'webhooks_execute', enabled: true },
    );
    await expect(
      t.run(
        { webhook_id: '111122223333444455', token: TOKEN },
        { signal: new AbortController().signal },
      ),
    ).rejects.toThrow(/at least one of/i);
  });
});
