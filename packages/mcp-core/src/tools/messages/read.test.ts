import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { describe, expect, it } from 'vitest';
import messagesRead from './read.js';
import '../../container.js';

describe('messages_read', () => {
  it('returns dualResult with wrapped messages', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken(
      'fake-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    );
    const T = messagesRead;
    const t = new T(
      { name: 'messages_read', path: 'inline', root: 'inline', store: null as never },
      { name: 'messages_read', enabled: true },
    );
    const r = (await t.run(
      { channel_id: '112233445566778899', limit: 3 },
      { signal: new AbortController().signal },
    )) as {
      isError: boolean;
      content: Array<{ text: string }>;
      structuredContent: { messages: unknown[]; channel_id: string; count: number };
    };
    expect(r.isError).toBe(false);
    expect(r.structuredContent.channel_id).toBe('112233445566778899');
    expect(r.structuredContent.count).toBe(3);
    const text = r.content[0]!.text;
    expect(text).toMatch(
      /<untrusted_discord_messages nonce="[0-9a-f]{16}" channel_id="112233445566778899" count="3">/,
    );
    expect(text).toContain('<msg id="100000101795321187" author="User 1">message 1 content</msg>');
  });

  it('rejects limit out of range via zod', async () => {
    const T = messagesRead;
    const t = new T(
      { name: 'messages_read', path: 'inline', root: 'inline', store: null as never },
      { name: 'messages_read', enabled: true },
    );
    const { z } = await import('zod');
    const schema = z.object(t.inputSchema);
    expect(schema.safeParse({ channel_id: '112233445566778899', limit: 0 }).success).toBe(false);
    expect(schema.safeParse({ channel_id: '112233445566778899', limit: 101 }).success).toBe(false);
  });
});
