import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import appEmojisCreate from './create.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';

describe('app_emojis_create', () => {
  it('POSTs the body and returns the new emoji', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    server.use(
      http.post(`${DISCORD_API}/applications/:appId/emojis`, async ({ request }) => {
        const body = (await request.json()) as { name: string };
        return HttpResponse.json({
          id: '850000000000000099',
          name: body.name,
          animated: false,
        });
      }),
    );
    const T = appEmojisCreate;
    const t = new T(
      { name: 'app_emojis_create', path: 'inline', root: 'inline', store: null as never },
      { name: 'app_emojis_create', enabled: true },
    );
    const r = (await t.run(
      {
        application_id: '111122223333444401',
        name: 'spark',
        image: 'data:image/png;base64,iVBORw0KG',
      },
      { signal: new AbortController().signal },
    )) as { isError: boolean; structuredContent: { id: string; name: string } };
    expect(r.isError).toBe(false);
    expect(r.structuredContent.name).toBe('spark');
  });
});
