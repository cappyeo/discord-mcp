import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import guildModifyWidget from './modify_widget.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';

describe('guild_modify_widget', () => {
  it('PATCHes /guilds/:gid/widget', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    server.use(
      http.patch(`${DISCORD_API}/guilds/:gid/widget`, async ({ request }) => {
        const body = (await request.json()) as { enabled?: boolean };
        return HttpResponse.json({ enabled: body.enabled ?? false, channel_id: null });
      }),
    );
    const T = guildModifyWidget;
    const t = new T(
      { name: 'guild_modify_widget', path: 'inline', root: 'inline', store: null as never },
      { name: 'guild_modify_widget', enabled: true },
    );
    const r = (await t.run(
      { guild_id: '999000999000999000', enabled: true },
      { signal: new AbortController().signal },
    )) as { isError: boolean; structuredContent: { enabled: boolean } };
    expect(r.isError).toBe(false);
    expect(r.structuredContent.enabled).toBe(true);
  });
});
