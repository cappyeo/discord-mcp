import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import invitesCreateChannel from './create_channel.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';

describe('invites_create_channel', () => {
  it('POSTs to /channels/{id}/invites with the optional fields', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    server.use(
      http.post(`${DISCORD_API}/channels/:channelId/invites`, async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        expect(body.max_age).toBe(3600);
        expect(body.max_uses).toBe(5);
        expect(body.unique).toBe(true);
        return HttpResponse.json({
          code: 'newcode',
          expires_at: '2026-04-29T12:00:00Z',
          max_age: 3600,
          max_uses: 5,
          temporary: false,
          unique: true,
          inviter: { id: '111122223333444401', username: 'bot' },
        });
      }),
    );
    const t = new invitesCreateChannel(
      { name: 'invites_create_channel', path: 'inline', root: 'inline', store: null as never },
      { name: 'invites_create_channel', enabled: true },
    );
    const r = (await t.run(
      { channel_id: '111122223333444402', max_age: 3600, max_uses: 5, unique: true },
      { signal: new AbortController().signal },
    )) as {
      isError: boolean;
      structuredContent: { code: string; max_age?: number; inviter_id?: string };
    };
    expect(r.isError).toBe(false);
    expect(r.structuredContent.code).toBe('newcode');
    expect(r.structuredContent.max_age).toBe(3600);
    expect(r.structuredContent.inviter_id).toBe('111122223333444401');
  });
});
