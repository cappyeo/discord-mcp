import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import applicationModifyCurrent from './modify_current.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';

describe('application_modify_current', () => {
  it('PATCHes /applications/@me and returns wrapped name/description', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    let url = '';
    server.use(
      http.patch(`${DISCORD_API}/applications/@me`, async ({ request }) => {
        url = request.url;
        const body = (await request.json()) as { description?: string };
        return HttpResponse.json({
          id: '111111111111111111',
          name: 'Test App',
          description: body.description ?? null,
          icon: null,
        });
      }),
    );
    const t = new applicationModifyCurrent(
      { name: 'application_modify_current', path: 'inline', root: 'inline', store: null as never },
      { name: 'application_modify_current', enabled: true },
    );
    const r = (await t.run(
      { description: 'updated app description' },
      { signal: new AbortController().signal },
    )) as {
      isError: boolean;
      structuredContent: { description: string | null; untrusted_text: string };
    };
    expect(r.isError).toBe(false);
    expect(url).toMatch(/\/applications\/(?:@me|%40me)/);
    expect(r.structuredContent.description).toBe('updated app description');
    expect(r.structuredContent.untrusted_text).toContain('untrusted_discord_channel_topic');
  });
});
