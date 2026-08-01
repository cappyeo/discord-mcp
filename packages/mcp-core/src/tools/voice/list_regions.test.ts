import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import voiceListRegions from './list_regions.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';

describe('voice_list_regions', () => {
  it('GETs /voice/regions', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    server.use(
      http.get(`${DISCORD_API}/voice/regions`, () => {
        return HttpResponse.json([
          { id: 'us-east', name: 'US East', optimal: true, deprecated: false, custom: false },
        ]);
      }),
    );
    const T = voiceListRegions;
    const t = new T(
      { name: 'voice_list_regions', path: 'inline', root: 'inline', store: null as never },
      { name: 'voice_list_regions', enabled: true },
    );
    const r = (await t.run({}, { signal: new AbortController().signal })) as {
      isError: boolean;
      structuredContent: { count: number };
    };
    expect(r.isError).toBe(false);
    expect(r.structuredContent.count).toBe(1);
  });
});
