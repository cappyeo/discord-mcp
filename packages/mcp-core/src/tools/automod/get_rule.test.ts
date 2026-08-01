import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import automodGetRule from './get_rule.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';

describe('automod_get_rule', () => {
  it('GETs /guilds/:gid/auto-moderation/rules/:rid and wraps trigger metadata', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    server.use(
      http.get(`${DISCORD_API}/guilds/:gid/auto-moderation/rules/:rid`, ({ params }) => {
        return HttpResponse.json({
          id: params.rid,
          guild_id: params.gid,
          name: 'Block badwords',
          creator_id: '111122223333444499',
          event_type: 1,
          trigger_type: 1,
          trigger_metadata: {
            keyword_filter: ['evil'],
            regex_patterns: [],
            allow_list: [],
          },
          actions: [{ type: 1 }],
          enabled: true,
          exempt_roles: [],
          exempt_channels: [],
        });
      }),
    );
    const T = automodGetRule;
    const t = new T(
      { name: 'automod_get_rule', path: 'inline', root: 'inline', store: null as never },
      { name: 'automod_get_rule', enabled: true },
    );
    const r = (await t.run(
      { guild_id: '999000999000999000', rule_id: '111122223333444401' },
      { signal: new AbortController().signal },
    )) as {
      isError: boolean;
      structuredContent: { name: string; trigger_type: number; untrusted_text: string };
    };
    expect(r.isError).toBe(false);
    expect(r.structuredContent.name).toBe('Block badwords');
    expect(r.structuredContent.trigger_type).toBe(1);
    expect(r.structuredContent.untrusted_text).toContain('untrusted_discord_channel_topic');
    expect(r.structuredContent.untrusted_text).toContain('evil');
  });
});
