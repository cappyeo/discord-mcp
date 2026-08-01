import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import guildGetWelcomeScreen from './get_welcome_screen.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';

describe('guild_get_welcome_screen', () => {
  it('GETs /guilds/:gid/welcome-screen and wraps text', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    server.use(
      http.get(`${DISCORD_API}/guilds/:gid/welcome-screen`, async () => {
        return HttpResponse.json({
          description: 'Welcome to our server!',
          welcome_channels: [
            {
              channel_id: '111122223333444401',
              description: 'Read the rules here',
              emoji_id: null,
              emoji_name: 'book',
            },
          ],
        });
      }),
    );
    const T = guildGetWelcomeScreen;
    const t = new T(
      { name: 'guild_get_welcome_screen', path: 'inline', root: 'inline', store: null as never },
      { name: 'guild_get_welcome_screen', enabled: true },
    );
    const r = (await t.run(
      { guild_id: '999000999000999000' },
      { signal: new AbortController().signal },
    )) as {
      isError: boolean;
      structuredContent: { welcome_channels: unknown[]; untrusted_text: string };
    };
    expect(r.isError).toBe(false);
    expect(r.structuredContent.welcome_channels).toHaveLength(1);
    expect(r.structuredContent.untrusted_text).toContain('untrusted_discord_channel_topic');
  });
});
