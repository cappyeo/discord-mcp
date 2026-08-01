import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import entitlementsConsume from './entitlements_consume.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';

describe('entitlements_consume', () => {
  it('POSTs /applications/:aid/entitlements/:eid/consume', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    server.use(
      http.post(
        `${DISCORD_API}/applications/:aid/entitlements/:eid/consume`,
        async () => new HttpResponse(null, { status: 204 }),
      ),
    );
    const T = entitlementsConsume;
    const t = new T(
      { name: 'entitlements_consume', path: 'inline', root: 'inline', store: null as never },
      { name: 'entitlements_consume', enabled: true },
    );
    const r = (await t.run(
      { application_id: '222222222222222222', entitlement_id: '111111111111111111' },
      { signal: new AbortController().signal },
    )) as { isError: boolean; structuredContent: { consumed: boolean } };
    expect(r.isError).toBe(false);
    expect(r.structuredContent.consumed).toBe(true);
  });
});
