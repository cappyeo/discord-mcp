import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import guildModify from './modify.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';

describe('guild_modify', () => {
  it('PATCHes the guild and returns projected fields', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    server.use(
      http.patch(`${DISCORD_API}/guilds/:gid`, async ({ request, params }) => {
        const body = (await request.json()) as { name?: string; description?: string };
        expect(body.name).toBe('Renamed');
        return HttpResponse.json({
          id: params.gid,
          name: body.name ?? 'Old',
          icon: 'icon_hash',
          owner_id: '111122223333444401',
          description: body.description ?? null,
          preferred_locale: 'en-US',
          features: ['COMMUNITY'],
        });
      }),
    );
    const T = guildModify;
    const t = new T(
      { name: 'guild_modify', path: 'inline', root: 'inline', store: null as never },
      { name: 'guild_modify', enabled: true },
    );
    const r = (await t.run(
      { guild_id: '999000999000999000', name: 'Renamed' },
      { signal: new AbortController().signal },
    )) as {
      isError: boolean;
      structuredContent: { id: string; name: string; untrusted_text: string };
    };
    expect(r.isError).toBe(false);
    expect(r.structuredContent.name).toBe('Renamed');
    expect(r.structuredContent.untrusted_text).toContain('untrusted_discord_channel_topic');
  });
});
