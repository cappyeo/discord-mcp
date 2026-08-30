import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import messagesSearchRecent from './search_recent.js';
import '../../container.js';

describe('messages_search_recent', () => {
  function createTool() {
    const T = messagesSearchRecent;
    return new T(
      { name: 'messages_search_recent', path: 'inline', root: 'inline', store: null as never },
      { name: 'messages_search_recent', enabled: true },
    );
  }

  it('filters default-handler messages by substring', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    // Default handler returns "message {n} content" for n in 1..3 with limit=3.
    const t = createTool();
    const r = (await t.run(
      { channel_id: '111122223333444401', query: 'message 2', limit: 3 },
      { signal: new AbortController().signal },
    )) as {
      isError: boolean;
      structuredContent: {
        matches: Array<{ content: string }>;
        scanned_count: number;
        oldest_scanned_id?: string;
        newest_scanned_id?: string;
      };
    };
    expect(r.isError).toBe(false);
    expect(r.structuredContent.scanned_count).toBe(3);
    expect(r.structuredContent.oldest_scanned_id).toBe('100000101795323141');
    expect(r.structuredContent.newest_scanned_id).toBe('100000101795321187');
    expect(r.structuredContent.matches.length).toBe(1);
    expect(r.structuredContent.matches[0]?.content).toContain('message 2');
  });

  it('returns scan boundaries even when the page has no matches', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    server.use(
      http.get('https://discord.com/api/v10/channels/:channelId/messages', () =>
        HttpResponse.json([
          {
            id: '999000999000000003',
            channel_id: '111122223333444401',
            content: 'alpha',
            author: { id: '999000999000000013', username: 'user3' },
            timestamp: '2026-04-28T12:03:00.000Z',
            edited_timestamp: null,
          },
          {
            id: '999000999000000002',
            channel_id: '111122223333444401',
            content: 'beta',
            author: { id: '999000999000000012', username: 'user2' },
            timestamp: '2026-04-28T12:02:00.000Z',
            edited_timestamp: null,
          },
        ]),
      ),
    );
    const r = (await createTool().run(
      { channel_id: '111122223333444401', query: 'missing', limit: 2 },
      { signal: new AbortController().signal },
    )) as { structuredContent: Record<string, unknown> };
    expect(r.structuredContent.matches).toEqual([]);
    expect(r.structuredContent.scanned_count).toBe(2);
    expect(r.structuredContent.newest_scanned_id).toBe('999000999000000003');
    expect(r.structuredContent.oldest_scanned_id).toBe('999000999000000002');
  });

  it('omits scan boundaries for an empty page', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    server.use(
      http.get('https://discord.com/api/v10/channels/:channelId/messages', ({ request }) => {
        expect(Object.fromEntries(new URL(request.url).searchParams)).toEqual({ limit: '100' });
        return HttpResponse.json([]);
      }),
    );
    const r = (await createTool().run(
      { channel_id: '111122223333444401', query: 'missing' },
      { signal: new AbortController().signal },
    )) as { structuredContent: Record<string, unknown> };
    expect(r.structuredContent.scanned_count).toBe(0);
    expect(r.structuredContent.oldest_scanned_id).toBeUndefined();
    expect(r.structuredContent.newest_scanned_id).toBeUndefined();
  });

  it.each([
    { field: 'before', value: '999000999000000099' },
    { field: 'after', value: '999000999000000001' },
  ] as const)('propagates the $field cursor to Discord', async ({ field, value }) => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    server.use(
      http.get('https://discord.com/api/v10/channels/:channelId/messages', ({ request }) => {
        expect(new URL(request.url).searchParams.get(field)).toBe(value);
        return HttpResponse.json([]);
      }),
    );
    await createTool().run(
      { channel_id: '111122223333444401', query: 'missing', [field]: value },
      { signal: new AbortController().signal },
    );
  });

  it('rejects simultaneous before and after cursors before Discord I/O', async () => {
    await expect(
      createTool().run(
        {
          channel_id: '111122223333444401',
          query: 'missing',
          before: '999000999000000099',
          after: '999000999000000001',
        },
        { signal: new AbortController().signal },
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});
