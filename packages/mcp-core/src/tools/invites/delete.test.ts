import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import invitesDelete from './delete.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';

describe('invites_delete', () => {
  it('DELETEs the invite and returns deleted:true', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    let called = false;
    server.use(
      http.delete(`${DISCORD_API}/invites/abc123def`, () => {
        called = true;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const t = new invitesDelete(
      { name: 'invites_delete', path: 'inline', root: 'inline', store: null as never },
      { name: 'invites_delete', enabled: true },
    );
    const r = (await t.run(
      { code: 'abc123def', audit_reason: 'cleanup' },
      { signal: new AbortController().signal },
    )) as { isError: boolean; structuredContent: { deleted: true; code: string } };
    expect(called).toBe(true);
    expect(r.isError).toBe(false);
    expect(r.structuredContent.deleted).toBe(true);
    expect(r.structuredContent.code).toBe('abc123def');
  });
});
