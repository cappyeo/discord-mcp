import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import guildDeleteIntegration from './delete_integration.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';

describe('guild_delete_integration', () => {
  it('DELETEs the integration', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    server.use(
      http.delete(
        `${DISCORD_API}/guilds/:gid/integrations/:id`,
        async () => new HttpResponse(null, { status: 204 }),
      ),
    );
    const T = guildDeleteIntegration;
    const t = new T(
      {
        name: 'guild_delete_integration',
        path: 'inline',
        root: 'inline',
        store: null as never,
      },
      { name: 'guild_delete_integration', enabled: true },
    );
    const r = (await t.run(
      { guild_id: '999000999000999000', integration_id: '111122223333444401' },
      { signal: new AbortController().signal },
    )) as { isError: boolean; structuredContent: { deleted: boolean } };
    expect(r.isError).toBe(false);
    expect(r.structuredContent.deleted).toBe(true);
  });

  it('declares confirm_required and destructiveHint', () => {
    const T = guildDeleteIntegration;
    const t = new T(
      {
        name: 'guild_delete_integration',
        path: 'inline',
        root: 'inline',
        store: null as never,
      },
      { name: 'guild_delete_integration', enabled: true },
    );
    expect(t.preconditions).toContain('confirm_required');
    expect(t.annotations.destructiveHint).toBe(true);
  });
});
