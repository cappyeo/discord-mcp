import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import auditLogGet from './get.js';
import '../../container.js';

describe('audit_log_get', () => {
  function createTool() {
    const T = auditLogGet;
    return new T(
      { name: 'audit_log_get', path: 'inline', root: 'inline', store: null as never },
      { name: 'audit_log_get', enabled: true },
    );
  }

  it('forwards filters and before, and returns oldest_id', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken(
      'fake-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    );
    server.use(
      http.get('https://discord.com/api/v10/guilds/:guildId/audit-logs', ({ request }) => {
        const url = new URL(request.url);
        expect(Object.fromEntries(url.searchParams)).toEqual({
          limit: '2',
          action_type: '20',
          user_id: '999000999000999001',
          before: '999000999000999099',
        });
        return HttpResponse.json({
          audit_log_entries: [
            { id: '999000999000999098', target_id: null, user_id: null, action_type: 20 },
            { id: '999000999000999097', target_id: null, user_id: null, action_type: 20 },
          ],
        });
      }),
    );
    const t = createTool();
    const r = (await t.run(
      {
        guild_id: '999000999000999000',
        limit: 2,
        action_type: 20,
        user_id: '999000999000999001',
        before: '999000999000999099',
      },
      { signal: new AbortController().signal },
    )) as {
      isError: boolean;
      structuredContent: {
        entries: Array<{ id: string; action_type: number }>;
        count: number;
        oldest_id?: string;
      };
    };
    expect(r.isError).toBe(false);
    expect(r.structuredContent.count).toBe(2);
    expect(r.structuredContent.entries[0]!.action_type).toBe(20);
    expect(r.structuredContent.oldest_id).toBe('999000999000999097');
  });

  it('omits oldest_id for an empty page', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token');
    server.use(
      http.get('https://discord.com/api/v10/guilds/:guildId/audit-logs', () =>
        HttpResponse.json({ audit_log_entries: [] }),
      ),
    );
    const r = (await createTool().run(
      { guild_id: '999000999000999000', limit: 2, before: '999000999000999099' },
      { signal: new AbortController().signal },
    )) as { structuredContent: Record<string, unknown> };
    expect(r.structuredContent).toEqual({ entries: [], count: 0 });
  });

  it('preserves legacy no-cursor behavior', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token');
    server.use(
      http.get('https://discord.com/api/v10/guilds/:guildId/audit-logs', ({ request }) => {
        const url = new URL(request.url);
        expect(Object.fromEntries(url.searchParams)).toEqual({ limit: '2' });
        return HttpResponse.json({
          audit_log_entries: [
            { id: '999000999000999098', target_id: null, user_id: null, action_type: 20 },
            { id: '999000999000999097', target_id: null, user_id: null, action_type: 21 },
          ],
        });
      }),
    );
    const r = (await createTool().run(
      { guild_id: '999000999000999000', limit: 2 },
      { signal: new AbortController().signal },
    )) as { structuredContent: { count: number; oldest_id?: string } };
    expect(r.structuredContent.count).toBe(2);
    expect(r.structuredContent.oldest_id).toBe('999000999000999097');
  });
});
