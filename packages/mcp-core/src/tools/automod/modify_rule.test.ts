import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import automodModifyRule from './modify_rule.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';

describe('automod_modify_rule', () => {
  it('PATCHes /guilds/:gid/auto-moderation/rules/:rid and returns updated rule', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    server.use(
      http.patch(
        `${DISCORD_API}/guilds/:gid/auto-moderation/rules/:rid`,
        async ({ params, request }) => {
          const body = (await request.json()) as { enabled?: boolean };
          expect(body.enabled).toBe(false);
          return HttpResponse.json({
            id: params.rid,
            name: 'No spam',
            trigger_type: 3,
            enabled: false,
          });
        },
      ),
    );
    const T = automodModifyRule;
    const t = new T(
      { name: 'automod_modify_rule', path: 'inline', root: 'inline', store: null as never },
      { name: 'automod_modify_rule', enabled: true },
    );
    const r = (await t.run(
      { guild_id: '999000999000999000', rule_id: '111122223333444401', enabled: false },
      { signal: new AbortController().signal },
    )) as { isError: boolean; structuredContent: { enabled: boolean } };
    expect(r.isError).toBe(false);
    expect(r.structuredContent.enabled).toBe(false);
  });
});
