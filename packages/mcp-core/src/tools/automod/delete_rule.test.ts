import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import automodDeleteRule from './delete_rule.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';

describe('automod_delete_rule', () => {
  it('DELETEs /guilds/:gid/auto-moderation/rules/:rid and returns deleted:true', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    server.use(
      http.delete(
        `${DISCORD_API}/guilds/:gid/auto-moderation/rules/:rid`,
        async () => new HttpResponse(null, { status: 204 }),
      ),
    );
    const T = automodDeleteRule;
    const t = new T(
      { name: 'automod_delete_rule', path: 'inline', root: 'inline', store: null as never },
      { name: 'automod_delete_rule', enabled: true },
    );
    const r = (await t.run(
      { guild_id: '999000999000999000', rule_id: '111122223333444401' },
      { signal: new AbortController().signal },
    )) as { isError: boolean; structuredContent: { deleted: boolean } };
    expect(r.isError).toBe(false);
    expect(r.structuredContent.deleted).toBe(true);
  });

  it('declares confirm_required and destructiveHint', () => {
    const T = automodDeleteRule;
    const t = new T(
      { name: 'automod_delete_rule', path: 'inline', root: 'inline', store: null as never },
      { name: 'automod_delete_rule', enabled: true },
    );
    expect(t.preconditions).toContain('confirm_required');
    expect(t.annotations.destructiveHint).toBe(true);
  });
});
