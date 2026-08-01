import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import guildListVoiceRegions from './list_voice_regions.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';

describe('guild_list_voice_regions', () => {
  it('GETs /guilds/:gid/regions', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    server.use(
      http.get(`${DISCORD_API}/guilds/:gid/regions`, async () => {
        return HttpResponse.json([
          { id: 'us-east', name: 'US East', optimal: true, deprecated: false, custom: false },
          { id: 'eu-west', name: 'EU West', optimal: false, deprecated: false, custom: false },
        ]);
      }),
    );
    const T = guildListVoiceRegions;
    const t = new T(
      { name: 'guild_list_voice_regions', path: 'inline', root: 'inline', store: null as never },
      { name: 'guild_list_voice_regions', enabled: true },
    );
    const r = (await t.run(
      { guild_id: '999000999000999000' },
      { signal: new AbortController().signal },
    )) as { isError: boolean; structuredContent: { count: number } };
    expect(r.isError).toBe(false);
    expect(r.structuredContent.count).toBe(2);
  });
});
