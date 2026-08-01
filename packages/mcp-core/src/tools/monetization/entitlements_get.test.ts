import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import entitlementsGet from './entitlements_get.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';

describe('entitlements_get', () => {
  it('GETs /applications/:aid/entitlements/:eid', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    server.use(
      http.get(`${DISCORD_API}/applications/:aid/entitlements/:eid`, ({ params }) => {
        return HttpResponse.json({
          id: params.eid,
          sku_id: '333333333333333333',
          application_id: params.aid,
          type: 8,
          deleted: false,
        });
      }),
    );
    const T = entitlementsGet;
    const t = new T(
      { name: 'entitlements_get', path: 'inline', root: 'inline', store: null as never },
      { name: 'entitlements_get', enabled: true },
    );
    const r = (await t.run(
      { application_id: '222222222222222222', entitlement_id: '111111111111111111' },
      { signal: new AbortController().signal },
    )) as { isError: boolean; structuredContent: { id: string } };
    expect(r.isError).toBe(false);
    expect(r.structuredContent.id).toBe('111111111111111111');
  });
});
