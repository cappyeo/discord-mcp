import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import automodListRules from './list_rules.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';

describe('automod_list_rules', () => {
  it('GETs /guilds/:gid/auto-moderation/rules and projects each rule', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    server.use(
      http.get(`${DISCORD_API}/guilds/:gid/auto-moderation/rules`, () => {
        return HttpResponse.json([
          {
            id: '111122223333444401',
            guild_id: '999000999000999000',
            name: 'No spam',
            trigger_type: 3,
            event_type: 1,
            enabled: true,
          },
          {
            id: '111122223333444402',
            guild_id: '999000999000999000',
            name: 'No badwords',
            trigger_type: 1,
            event_type: 1,
            enabled: true,
          },
        ]);
      }),
    );
    const T = automodListRules;
    const t = new T(
      { name: 'automod_list_rules', path: 'inline', root: 'inline', store: null as never },
      { name: 'automod_list_rules', enabled: true },
    );
    const r = (await t.run(
      { guild_id: '999000999000999000' },
      { signal: new AbortController().signal },
    )) as {
      isError: boolean;
      structuredContent: { count: number; untrusted_names: string };
    };
    expect(r.isError).toBe(false);
    expect(r.structuredContent.count).toBe(2);
    expect(r.structuredContent.untrusted_names).toContain('untrusted_discord_channel_topic');
    expect(r.structuredContent.untrusted_names).toContain('No spam');
  });
});
