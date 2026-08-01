import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import webhooksModify from './modify.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';

describe('webhooks_modify', () => {
  it('PATCHes the webhook and returns projected fields', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    server.use(
      http.patch(`${DISCORD_API}/webhooks/:wid`, async ({ request, params }) => {
        const body = (await request.json()) as { name?: string };
        expect(body.name).toBe('Renamed');
        return HttpResponse.json({
          id: params.wid,
          type: 1,
          name: body.name,
          avatar: null,
          channel_id: '111122223333444455',
          application_id: null,
        });
      }),
    );
    const T = webhooksModify;
    const t = new T(
      { name: 'webhooks_modify', path: 'inline', root: 'inline', store: null as never },
      { name: 'webhooks_modify', enabled: true },
    );
    const r = (await t.run(
      { webhook_id: '111122223333444455', name: 'Renamed' },
      { signal: new AbortController().signal },
    )) as { isError: boolean; structuredContent: { name: string | null; untrusted_name: string } };
    expect(r.isError).toBe(false);
    expect(r.structuredContent.name).toBe('Renamed');
    expect(r.structuredContent.untrusted_name).toContain('untrusted_discord_username');
  });
});
