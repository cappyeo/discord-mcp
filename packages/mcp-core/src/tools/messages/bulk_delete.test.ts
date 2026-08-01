import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import messagesBulkDelete from './bulk_delete.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';

describe('messages_bulk_delete', () => {
  it('POSTs the message_ids array and returns deleted:true', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    let receivedBody: unknown = null;
    server.use(
      http.post(`${DISCORD_API}/channels/:channelId/messages/bulk-delete`, async ({ request }) => {
        receivedBody = await request.json();
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const T = messagesBulkDelete;
    const t = new T(
      { name: 'messages_bulk_delete', path: 'inline', root: 'inline', store: null as never },
      { name: 'messages_bulk_delete', enabled: true },
    );
    const r = (await t.run(
      {
        channel_id: '111122223333444455',
        message_ids: ['999000999000999001', '999000999000999002'],
      },
      { signal: new AbortController().signal },
    )) as {
      isError: boolean;
      structuredContent: { deleted: boolean; count: number };
    };
    expect(r.isError).toBe(false);
    expect(r.structuredContent.count).toBe(2);
    expect(receivedBody).toMatchObject({
      messages: ['999000999000999001', '999000999000999002'],
    });
  });

  it('declares confirm_required precondition and destructiveHint', () => {
    const T = messagesBulkDelete;
    const t = new T(
      { name: 'messages_bulk_delete', path: 'inline', root: 'inline', store: null as never },
      { name: 'messages_bulk_delete', enabled: true },
    );
    expect(t.preconditions).toContain('confirm_required');
    expect(t.annotations.destructiveHint).toBe(true);
  });
});
