import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import soundboardDelete from './delete_guild_sound.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';

describe('soundboard_delete_guild_sound', () => {
  it('DELETEs /guilds/:gid/soundboard-sounds/:sid', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    server.use(
      http.delete(
        `${DISCORD_API}/guilds/:gid/soundboard-sounds/:sid`,
        async () => new HttpResponse(null, { status: 204 }),
      ),
    );
    const T = soundboardDelete;
    const t = new T(
      {
        name: 'soundboard_delete_guild_sound',
        path: 'inline',
        root: 'inline',
        store: null as never,
      },
      { name: 'soundboard_delete_guild_sound', enabled: true },
    );
    const r = (await t.run(
      { guild_id: '999000999000999000', sound_id: '111111111111111111' },
      { signal: new AbortController().signal },
    )) as { isError: boolean; structuredContent: { deleted: boolean } };
    expect(r.isError).toBe(false);
    expect(r.structuredContent.deleted).toBe(true);
  });

  it('declares confirm_required and destructiveHint', () => {
    const T = soundboardDelete;
    const t = new T(
      {
        name: 'soundboard_delete_guild_sound',
        path: 'inline',
        root: 'inline',
        store: null as never,
      },
      { name: 'soundboard_delete_guild_sound', enabled: true },
    );
    expect(t.preconditions).toContain('confirm_required');
    expect(t.annotations.destructiveHint).toBe(true);
  });
});
