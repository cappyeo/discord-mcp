import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import subscriptionsList from './subscriptions_list.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';

describe('subscriptions_list', () => {
  it('GETs /skus/:sid/subscriptions', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    server.use(
      http.get(`${DISCORD_API}/skus/:sid/subscriptions`, () => {
        return HttpResponse.json([
          {
            id: '111111111111111111',
            user_id: '222222222222222222',
            sku_ids: ['333333333333333333'],
            entitlement_ids: ['444444444444444444'],
            current_period_start: '2026-01-01T00:00:00Z',
            current_period_end: '2026-02-01T00:00:00Z',
            status: 0,
          },
        ]);
      }),
    );
    const T = subscriptionsList;
    const t = new T(
      { name: 'subscriptions_list', path: 'inline', root: 'inline', store: null as never },
      { name: 'subscriptions_list', enabled: true },
    );
    const r = (await t.run(
      { sku_id: '333333333333333333' },
      { signal: new AbortController().signal },
    )) as { isError: boolean; structuredContent: { count: number } };
    expect(r.isError).toBe(false);
    expect(r.structuredContent.count).toBe(1);
  });
});
