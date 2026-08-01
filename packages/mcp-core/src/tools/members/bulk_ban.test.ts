import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import membersBulkBan from './bulk_ban.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';

describe('members_bulk_ban', () => {
  it('POSTs /guilds/:gid/bulk-ban and projects banned/failed arrays', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    server.use(
      http.post(`${DISCORD_API}/guilds/:gid/bulk-ban`, async ({ request }) => {
        const body = (await request.json()) as { user_ids: string[] };
        expect(body.user_ids.length).toBe(2);
        return HttpResponse.json({
          banned_users: ['111122223333444401'],
          failed_users: ['111122223333444402'],
        });
      }),
    );
    const T = membersBulkBan;
    const t = new T(
      { name: 'members_bulk_ban', path: 'inline', root: 'inline', store: null as never },
      { name: 'members_bulk_ban', enabled: true },
    );
    const r = (await t.run(
      {
        guild_id: '999000999000999000',
        user_ids: ['111122223333444401', '111122223333444402'],
      },
      { signal: new AbortController().signal },
    )) as {
      isError: boolean;
      structuredContent: { banned_count: number; failed_count: number };
    };
    expect(r.isError).toBe(false);
    expect(r.structuredContent.banned_count).toBe(1);
    expect(r.structuredContent.failed_count).toBe(1);
  });

  it('declares confirm_required and destructiveHint', () => {
    const T = membersBulkBan;
    const t = new T(
      { name: 'members_bulk_ban', path: 'inline', root: 'inline', store: null as never },
      { name: 'members_bulk_ban', enabled: true },
    );
    expect(t.preconditions).toContain('confirm_required');
    expect(t.annotations.destructiveHint).toBe(true);
  });
});
