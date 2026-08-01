import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import entitlementsCreateTest from './entitlements_create_test.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';

describe('entitlements_create_test', () => {
  it('POSTs /applications/:aid/entitlements', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    server.use(
      http.post(`${DISCORD_API}/applications/:aid/entitlements`, async ({ params, request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({
          id: '111111111111111111',
          sku_id: body.sku_id,
          application_id: params.aid,
          type: 8,
        });
      }),
    );
    const T = entitlementsCreateTest;
    const t = new T(
      { name: 'entitlements_create_test', path: 'inline', root: 'inline', store: null as never },
      { name: 'entitlements_create_test', enabled: true },
    );
    const r = (await t.run(
      {
        application_id: '222222222222222222',
        sku_id: '333333333333333333',
        owner_id: '444444444444444444',
        owner_type: 2,
      },
      { signal: new AbortController().signal },
    )) as { isError: boolean; structuredContent: { id: string } };
    expect(r.isError).toBe(false);
    expect(r.structuredContent.id).toBe('111111111111111111');
  });
});
