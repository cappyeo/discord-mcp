import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import invitesGet from './get.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';

describe('invites_get', () => {
  it('GETs invite by code with optional counts and wraps names untrusted', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    server.use(
      http.get(`${DISCORD_API}/invites/abc123def`, ({ request }) => {
        const url = new URL(request.url);
        expect(url.searchParams.get('with_counts')).toBe('true');
        return HttpResponse.json({
          code: 'abc123def',
          guild: { id: '111122223333444401', name: 'Cool Guild' },
          channel: { id: '111122223333444402', name: 'general', type: 0 },
          inviter: { id: '111122223333444403', username: 'alice', global_name: 'Alice' },
          approximate_member_count: 100,
          approximate_presence_count: 42,
        });
      }),
    );
    const t = new invitesGet(
      { name: 'invites_get', path: 'inline', root: 'inline', store: null as never },
      { name: 'invites_get', enabled: true },
    );
    const r = (await t.run(
      { code: 'abc123def', with_counts: true },
      { signal: new AbortController().signal },
    )) as {
      isError: boolean;
      structuredContent: {
        code: string;
        guild_id?: string;
        channel_id: string | null;
        inviter_name?: string;
        approximate_member_count?: number;
        untrusted_names: string;
      };
    };
    expect(r.isError).toBe(false);
    expect(r.structuredContent.code).toBe('abc123def');
    expect(r.structuredContent.guild_id).toBe('111122223333444401');
    expect(r.structuredContent.channel_id).toBe('111122223333444402');
    expect(r.structuredContent.inviter_name).toBe('Alice');
    expect(r.structuredContent.approximate_member_count).toBe(100);
    expect(r.structuredContent.untrusted_names).toContain('untrusted_discord_channel_topic');
    expect(r.structuredContent.untrusted_names).toContain('Cool Guild');
  });
});
