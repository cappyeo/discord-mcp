import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import entitlementsDeleteTest from './entitlements_delete_test.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';

describe('entitlements_delete_test', () => {
  it('DELETEs /applications/:aid/entitlements/:eid', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    server.use(
      http.delete(
        `${DISCORD_API}/applications/:aid/entitlements/:eid`,
        async () => new HttpResponse(null, { status: 204 }),
      ),
    );
    const T = entitlementsDeleteTest;
    const t = new T(
      { name: 'entitlements_delete_test', path: 'inline', root: 'inline', store: null as never },
      { name: 'entitlements_delete_test', enabled: true },
    );
    const r = (await t.run(
      { application_id: '222222222222222222', entitlement_id: '111111111111111111' },
      { signal: new AbortController().signal },
    )) as { isError: boolean; structuredContent: { deleted: boolean } };
    expect(r.isError).toBe(false);
    expect(r.structuredContent.deleted).toBe(true);
  });

  it('declares confirm_required and destructiveHint', () => {
    const T = entitlementsDeleteTest;
    const t = new T(
      { name: 'entitlements_delete_test', path: 'inline', root: 'inline', store: null as never },
      { name: 'entitlements_delete_test', enabled: true },
    );
    expect(t.preconditions).toContain('confirm_required');
    expect(t.annotations.destructiveHint).toBe(true);
  });
});
