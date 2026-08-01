import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import webhooksDelete from './delete.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';

describe('webhooks_delete', () => {
  it('DELETEs the webhook and returns deleted:true', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    let called = false;
    server.use(
      http.delete(`${DISCORD_API}/webhooks/:wid`, () => {
        called = true;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const T = webhooksDelete;
    const t = new T(
      { name: 'webhooks_delete', path: 'inline', root: 'inline', store: null as never },
      { name: 'webhooks_delete', enabled: true },
    );
    const r = (await t.run(
      { webhook_id: '111122223333444455', audit_reason: 'cleanup' },
      { signal: new AbortController().signal },
    )) as { isError: boolean; structuredContent: { deleted: true; webhook_id: string } };
    expect(called).toBe(true);
    expect(r.isError).toBe(false);
    expect(r.structuredContent.deleted).toBe(true);
  });
});
