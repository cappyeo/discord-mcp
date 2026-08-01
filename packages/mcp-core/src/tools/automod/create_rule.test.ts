import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import automodCreateRule from './create_rule.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';

describe('automod_create_rule', () => {
  it('POSTs /guilds/:gid/auto-moderation/rules and returns the new rule', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    server.use(
      http.post(`${DISCORD_API}/guilds/:gid/auto-moderation/rules`, async ({ request }) => {
        const body = (await request.json()) as { name: string; trigger_type: number };
        expect(body.name).toBe('No spam');
        expect(body.trigger_type).toBe(3);
        return HttpResponse.json({
          id: '111122223333444401',
          name: 'No spam',
          trigger_type: 3,
          enabled: true,
        });
      }),
    );
    const T = automodCreateRule;
    const t = new T(
      { name: 'automod_create_rule', path: 'inline', root: 'inline', store: null as never },
      { name: 'automod_create_rule', enabled: true },
    );
    const r = (await t.run(
      {
        guild_id: '999000999000999000',
        name: 'No spam',
        event_type: 1,
        trigger_type: 3,
        actions: [{ type: 1 }],
      },
      { signal: new AbortController().signal },
    )) as { isError: boolean; structuredContent: { id: string; trigger_type: number } };
    expect(r.isError).toBe(false);
    expect(r.structuredContent.id).toBe('111122223333444401');
    expect(r.structuredContent.trigger_type).toBe(3);
  });
});
