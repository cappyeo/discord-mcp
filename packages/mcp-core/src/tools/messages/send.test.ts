import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { describe, expect, it } from 'vitest';
import messagesSend from './send.js';
import '../../container.js';

describe('messages_send tool', () => {
  it('returns dualResult with message_id, jump_url, timestamp on success', async () => {
    // Use global fetch so msw can intercept (undici bypasses msw's ClientRequest/fetch interceptors)
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken(
      'fake.test.token-abcdefghijklmnopqrstuvwxyz',
    );

    const ToolCls = messagesSend;
    const instance = new ToolCls(
      { name: 'messages_send', path: 'memory', root: 'memory', store: null as never },
      { name: 'messages_send', enabled: true },
    );

    const result = await instance.run(
      { channel_id: '112233445566778899', content: 'hello world' },
      { signal: new AbortController().signal },
    );

    expect(result).toMatchObject({
      isError: false,
      structuredContent: {
        message_id: '999000999000999000',
        channel_id: '112233445566778899',
        timestamp: '2026-04-28T12:00:00.000000+00:00',
      },
    });
    const data = (result as { structuredContent: { jump_url: string } }).structuredContent;
    expect(data.jump_url).toMatch(
      /^https:\/\/discord\.com\/channels\/999000999000999000\/112233445566778899\/999000999000999000$/,
    );
  });

  it('rejects empty content via zod', async () => {
    // Note: defineTool's schema is enforced by buildServer (Task 13), not by Tool.run() directly.
    // For this test, we validate the schema directly:
    const ToolCls = messagesSend;
    const instance = new ToolCls(
      { name: 'messages_send', path: 'memory', root: 'memory', store: null as never },
      { name: 'messages_send', enabled: true },
    );
    // Build the parsed input via the instance schema
    const { z } = await import('zod');
    const schema = z.object(instance.inputSchema);
    const parsed = schema.safeParse({ channel_id: '112233445566778899' });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((i) => i.path.includes('content'))).toBe(true);
    }
  });
});
