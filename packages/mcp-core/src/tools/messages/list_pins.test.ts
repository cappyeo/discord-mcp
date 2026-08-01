import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import messagesListPins from './list_pins.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';

describe('messages_list_pins', () => {
  it('returns pinned messages with content wrapped', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    server.use(
      http.get(`${DISCORD_API}/channels/:channelId/pins`, async ({ params }) =>
        HttpResponse.json([
          {
            id: '999000999000999001',
            channel_id: params.channelId,
            content: 'pinned welcome',
            author: { id: '111122223333444401', username: 'bot', global_name: 'Bot' },
            timestamp: '2026-04-28T12:00:00.000000+00:00',
          },
        ]),
      ),
    );
    const T = messagesListPins;
    const t = new T(
      { name: 'messages_list_pins', path: 'inline', root: 'inline', store: null as never },
      { name: 'messages_list_pins', enabled: true },
    );
    const r = (await t.run(
      { channel_id: '111122223333444401' },
      { signal: new AbortController().signal },
    )) as {
      isError: boolean;
      content: Array<{ text: string }>;
      structuredContent: { pins: unknown[]; count: number };
    };
    expect(r.isError).toBe(false);
    expect(r.structuredContent.count).toBe(1);
    expect(r.content[0]?.text).toMatch(/<untrusted_discord_messages/);
  });
});
