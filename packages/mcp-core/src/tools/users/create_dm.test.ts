import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import usersCreateDm from './create_dm.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';

describe('users_create_dm', () => {
  // Routes.userChannels() is a template literal — `@me` passes through unencoded.
  it('POSTs /users/@me/channels with raw @me in URL', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    let capturedUrl: string | null = null;
    server.use(
      http.post(`${DISCORD_API}/users/@me/channels`, async ({ request }) => {
        capturedUrl = request.url;
        const body = (await request.json()) as { recipient_id: string };
        expect(body.recipient_id).toBe('111122223333444499');
        return HttpResponse.json({
          id: '111122223333555501',
          type: 1,
          recipients: [{ id: '111122223333444499', username: 'alice' }],
        });
      }),
    );
    const T = usersCreateDm;
    const t = new T(
      { name: 'users_create_dm', path: 'inline', root: 'inline', store: null as never },
      { name: 'users_create_dm', enabled: true },
    );
    const r = (await t.run(
      { recipient_id: '111122223333444499' },
      { signal: new AbortController().signal },
    )) as {
      isError: boolean;
      structuredContent: { channel_id: string; type: number; recipient_ids: string[] };
    };
    expect(r.isError).toBe(false);
    expect(r.structuredContent.channel_id).toBe('111122223333555501');
    expect(r.structuredContent.recipient_ids).toEqual(['111122223333444499']);
    expect(capturedUrl).toContain('/users/@me/channels');
    expect(capturedUrl).not.toContain('%40me');
  });
});
