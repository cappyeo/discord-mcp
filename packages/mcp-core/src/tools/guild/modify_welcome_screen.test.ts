import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import guildModifyWelcomeScreen from './modify_welcome_screen.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';

describe('guild_modify_welcome_screen', () => {
  it('PATCHes /guilds/:gid/welcome-screen', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    server.use(
      http.patch(`${DISCORD_API}/guilds/:gid/welcome-screen`, async ({ request }) => {
        const body = (await request.json()) as { description?: string };
        return HttpResponse.json({
          description: body.description ?? 'Welcome',
          welcome_channels: [],
        });
      }),
    );
    const T = guildModifyWelcomeScreen;
    const t = new T(
      {
        name: 'guild_modify_welcome_screen',
        path: 'inline',
        root: 'inline',
        store: null as never,
      },
      { name: 'guild_modify_welcome_screen', enabled: true },
    );
    const r = (await t.run(
      { guild_id: '999000999000999000', description: 'New welcome' },
      { signal: new AbortController().signal },
    )) as { isError: boolean; structuredContent: { description: string } };
    expect(r.isError).toBe(false);
    expect(r.structuredContent.description).toBe('New welcome');
  });
});
