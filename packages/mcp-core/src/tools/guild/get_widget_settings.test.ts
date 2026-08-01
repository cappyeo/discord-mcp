import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import guildGetWidgetSettings from './get_widget_settings.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';

describe('guild_get_widget_settings', () => {
  it('GETs /guilds/:gid/widget', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    server.use(
      http.get(`${DISCORD_API}/guilds/:gid/widget`, async () => {
        return HttpResponse.json({ enabled: true, channel_id: '111122223333444401' });
      }),
    );
    const T = guildGetWidgetSettings;
    const t = new T(
      {
        name: 'guild_get_widget_settings',
        path: 'inline',
        root: 'inline',
        store: null as never,
      },
      { name: 'guild_get_widget_settings', enabled: true },
    );
    const r = (await t.run(
      { guild_id: '999000999000999000' },
      { signal: new AbortController().signal },
    )) as { isError: boolean; structuredContent: { enabled: boolean } };
    expect(r.isError).toBe(false);
    expect(r.structuredContent.enabled).toBe(true);
  });
});
