import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import applicationGetCurrent from './get_current.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';

describe('application_get_current', () => {
  it('GETs /applications/@me and wraps name/description', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    let url = '';
    server.use(
      http.get(`${DISCORD_API}/applications/@me`, ({ request }) => {
        url = request.url;
        return HttpResponse.json({
          id: '111111111111111111',
          name: 'Test App',
          description: 'a test app',
          icon: null,
          flags: 64,
          tags: ['dev', 'test'],
          owner: { id: '222222222222222222' },
        });
      }),
    );
    const t = new applicationGetCurrent(
      { name: 'application_get_current', path: 'inline', root: 'inline', store: null as never },
      { name: 'application_get_current', enabled: true },
    );
    const r = (await t.run({}, { signal: new AbortController().signal })) as {
      isError: boolean;
      structuredContent: { id: string; name: string; untrusted_text: string };
    };
    expect(r.isError).toBe(false);
    // Routes.currentApplication() returns the literal "/applications/@me" template.
    expect(url).toMatch(/\/applications\/(?:@me|%40me)/);
    expect(r.structuredContent.id).toBe('111111111111111111');
    expect(r.structuredContent.untrusted_text).toContain('untrusted_discord_channel_topic');
    expect(r.structuredContent.untrusted_text).toContain('Test App');
  });
});
