import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import subscriptionsGet from './subscriptions_get.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';

describe('subscriptions_get', () => {
  it('GETs /skus/:sid/subscriptions/:subid', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    server.use(
      http.get(`${DISCORD_API}/skus/:sid/subscriptions/:subid`, ({ params }) => {
        return HttpResponse.json({
          id: params.subid,
          user_id: '222222222222222222',
          sku_ids: [params.sid],
          entitlement_ids: [],
          current_period_start: '2026-01-01T00:00:00Z',
          current_period_end: '2026-02-01T00:00:00Z',
          status: 0,
        });
      }),
    );
    const T = subscriptionsGet;
    const t = new T(
      { name: 'subscriptions_get', path: 'inline', root: 'inline', store: null as never },
      { name: 'subscriptions_get', enabled: true },
    );
    const r = (await t.run(
      { sku_id: '333333333333333333', subscription_id: '111111111111111111' },
      { signal: new AbortController().signal },
    )) as { isError: boolean; structuredContent: { id: string } };
    expect(r.isError).toBe(false);
    expect(r.structuredContent.id).toBe('111111111111111111');
  });
});
