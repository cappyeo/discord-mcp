import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import appEmojisGet from './get.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';

describe('app_emojis_get', () => {
  it('returns the single app emoji', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    server.use(
      http.get(`${DISCORD_API}/applications/:appId/emojis/:emojiId`, async ({ params }) =>
        HttpResponse.json({ id: params.emojiId, name: 'spark', animated: false }),
      ),
    );
    const T = appEmojisGet;
    const t = new T(
      { name: 'app_emojis_get', path: 'inline', root: 'inline', store: null as never },
      { name: 'app_emojis_get', enabled: true },
    );
    const r = (await t.run(
      { application_id: '111122223333444401', emoji_id: '850000000000000001' },
      { signal: new AbortController().signal },
    )) as { isError: boolean; structuredContent: { name: string } };
    expect(r.isError).toBe(false);
    expect(r.structuredContent.name).toBe('spark');
  });
});
