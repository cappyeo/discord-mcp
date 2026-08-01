import { server } from '@cappyeo/discord-mcp-server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import webhooksGet from './get.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';

describe('webhooks_get', () => {
  it('GETs the webhook and projects token OUT of the response', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    server.use(
      http.get(`${DISCORD_API}/webhooks/:wid`, () => {
        return HttpResponse.json({
          id: '164383424266383145',
          type: 1,
          name: 'CI',
          avatar: null,
          channel_id: '111122223333444455',
          application_id: null,
          token: 'should-not-leak-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        });
      }),
    );
    const T = webhooksGet;
    const t = new T(
      { name: 'webhooks_get', path: 'inline', root: 'inline', store: null as never },
      { name: 'webhooks_get', enabled: true },
    );
    const r = (await t.run(
      { webhook_id: '111122223333444455' },
      { signal: new AbortController().signal },
    )) as {
      isError: boolean;
      structuredContent: Record<string, unknown>;
    };
    expect(r.isError).toBe(false);
    expect(r.structuredContent.id).toBe('164383424266383145');
    expect(r.structuredContent.token).toBeUndefined();
    expect(r.structuredContent.untrusted_name).toContain('untrusted_discord_username');
  });
});
