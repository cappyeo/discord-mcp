import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import entitlementsList from './entitlements_list.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';

describe('entitlements_list', () => {
  it('GETs /applications/:aid/entitlements', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    server.use(
      http.get(`${DISCORD_API}/applications/:aid/entitlements`, () => {
        return HttpResponse.json([
          {
            id: '111111111111111111',
            sku_id: '333333333333333333',
            application_id: '222222222222222222',
            user_id: '444444444444444444',
            type: 8,
            deleted: false,
          },
        ]);
      }),
    );
    const T = entitlementsList;
    const t = new T(
      { name: 'entitlements_list', path: 'inline', root: 'inline', store: null as never },
      { name: 'entitlements_list', enabled: true },
    );
    const r = (await t.run(
      { application_id: '222222222222222222' },
      { signal: new AbortController().signal },
    )) as { isError: boolean; structuredContent: { count: number } };
    expect(r.isError).toBe(false);
    expect(r.structuredContent.count).toBe(1);
  });
});
