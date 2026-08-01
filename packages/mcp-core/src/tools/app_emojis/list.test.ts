import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import appEmojisList from './list.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';

describe('app_emojis_list', () => {
  it('returns the application emoji list (items[])', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    server.use(
      http.get(`${DISCORD_API}/applications/:appId/emojis`, async () =>
        HttpResponse.json({
          items: [
            { id: '850000000000000001', name: 'sparkle', animated: false },
            { id: '850000000000000002', name: 'fire', animated: true },
          ],
        }),
      ),
    );
    const T = appEmojisList;
    const t = new T(
      { name: 'app_emojis_list', path: 'inline', root: 'inline', store: null as never },
      { name: 'app_emojis_list', enabled: true },
    );
    const r = (await t.run(
      { application_id: '111122223333444401' },
      { signal: new AbortController().signal },
    )) as { isError: boolean; structuredContent: { count: number } };
    expect(r.isError).toBe(false);
    expect(r.structuredContent.count).toBe(2);
  });
});
