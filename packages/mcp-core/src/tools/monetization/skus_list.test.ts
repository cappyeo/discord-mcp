import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import skusList from './skus_list.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';

describe('skus_list', () => {
  it('GETs /applications/:aid/skus', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    server.use(
      http.get(`${DISCORD_API}/applications/:aid/skus`, () => {
        return HttpResponse.json([
          {
            id: '111111111111111111',
            type: 5,
            application_id: '222222222222222222',
            name: 'Premium',
            slug: 'premium',
            flags: 128,
          },
        ]);
      }),
    );
    const T = skusList;
    const t = new T(
      { name: 'skus_list', path: 'inline', root: 'inline', store: null as never },
      { name: 'skus_list', enabled: true },
    );
    const r = (await t.run(
      { application_id: '222222222222222222' },
      { signal: new AbortController().signal },
    )) as { isError: boolean; structuredContent: { count: number } };
    expect(r.isError).toBe(false);
    expect(r.structuredContent.count).toBe(1);
  });
});
