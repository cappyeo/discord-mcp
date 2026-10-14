import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import channelsList from './list.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';

describe('channels_list', () => {
  it('returns dualResult with id+name+type per channel', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken(
      'fake-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    );
    const T = channelsList;
    const t = new T(
      { name: 'channels_list', path: 'inline', root: 'inline', store: null as never },
      { name: 'channels_list', enabled: true },
    );
    const r = (await t.run(
      { guild_id: '999000999000999000' },
      { signal: new AbortController().signal },
    )) as {
      isError: boolean;
      structuredContent: {
        channels: Array<{ id: string; name: string; type: number }>;
        count: number;
      };
    };
    expect(r.isError).toBe(false);
    expect(r.structuredContent.count).toBe(3);
    expect(r.structuredContent.channels.map((c) => c.name)).toEqual([
      'general',
      'announcements',
      'voice-lobby',
    ]);
  });

  it('projects role and member permission overwrites with string bitfields', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken(
      'fake-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    );
    server.use(
      http.get(`${DISCORD_API}/guilds/:guildId/channels`, () =>
        HttpResponse.json([
          {
            id: '111122223333444455',
            name: 'private',
            type: 0,
            position: 0,
            permission_overwrites: [
              { id: '999000999000999000', type: 0, allow: '1024', deny: '2048' },
              { id: '111122223333444401', type: 1, allow: '274877906944', deny: '0' },
            ],
          },
        ]),
      ),
    );
    const T = channelsList;
    const t = new T(
      { name: 'channels_list', path: 'inline', root: 'inline', store: null as never },
      { name: 'channels_list', enabled: true },
    );
    const r = (await t.run(
      { guild_id: '999000999000999000' },
      { signal: new AbortController().signal },
    )) as { structuredContent: { channels: Array<Record<string, unknown>> } };
    expect(r.structuredContent.channels[0]?.permission_overwrites).toEqual([
      { id: '999000999000999000', type: 0, allow: '1024', deny: '2048' },
      { id: '111122223333444401', type: 1, allow: '274877906944', deny: '0' },
    ]);
  });

  it('keeps omitted overwrites absent while preserving an actual empty array', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken(
      'fake-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    );
    server.use(
      http.get(`${DISCORD_API}/guilds/:guildId/channels`, () =>
        HttpResponse.json([
          { id: '111122223333444455', name: 'category', type: 4, position: 0 },
          {
            id: '111122223333444466',
            name: 'public',
            type: 0,
            position: 1,
            permission_overwrites: [],
          },
        ]),
      ),
    );
    const T = channelsList;
    const t = new T(
      { name: 'channels_list', path: 'inline', root: 'inline', store: null as never },
      { name: 'channels_list', enabled: true },
    );
    const r = (await t.run(
      { guild_id: '999000999000999000' },
      { signal: new AbortController().signal },
    )) as { structuredContent: { channels: Array<Record<string, unknown>> } };
    expect(r.structuredContent.channels[0]).not.toHaveProperty('permission_overwrites');
    expect(r.structuredContent.channels[1]?.permission_overwrites).toEqual([]);
  });
});
