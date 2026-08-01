import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import rolesDelete from './delete.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';

describe('roles_delete', () => {
  it('DELETEs /guilds/:gid/roles/:rid and returns deleted:true', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    server.use(
      http.delete(
        `${DISCORD_API}/guilds/:gid/roles/:rid`,
        async () => new HttpResponse(null, { status: 204 }),
      ),
    );
    const T = rolesDelete;
    const t = new T(
      { name: 'roles_delete', path: 'inline', root: 'inline', store: null as never },
      { name: 'roles_delete', enabled: true },
    );
    const r = (await t.run(
      { guild_id: '999000999000999000', role_id: '222233334444555566' },
      { signal: new AbortController().signal },
    )) as { isError: boolean; structuredContent: { deleted: boolean } };
    expect(r.isError).toBe(false);
    expect(r.structuredContent.deleted).toBe(true);
  });

  it('declares confirm_required and destructiveHint', () => {
    const T = rolesDelete;
    const t = new T(
      { name: 'roles_delete', path: 'inline', root: 'inline', store: null as never },
      { name: 'roles_delete', enabled: true },
    );
    expect(t.preconditions).toContain('confirm_required');
    expect(t.annotations.destructiveHint).toBe(true);
  });
});
