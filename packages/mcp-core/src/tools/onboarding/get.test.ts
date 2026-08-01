import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import onboardingGet from './get.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';

describe('onboarding_get', () => {
  it('GETs /guilds/:gid/onboarding and wraps prompt titles', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    server.use(
      http.get(`${DISCORD_API}/guilds/:gid/onboarding`, ({ params }) => {
        return HttpResponse.json({
          guild_id: params.gid,
          prompts: [
            {
              id: '1',
              type: 0,
              title: 'Welcome!',
              options: [{ id: 'opt1', title: 'Option A', description: 'desc' }],
              single_select: true,
              required: false,
              in_onboarding: true,
            },
          ],
          default_channel_ids: [],
          enabled: true,
          mode: 0,
        });
      }),
    );
    const T = onboardingGet;
    const t = new T(
      { name: 'onboarding_get', path: 'inline', root: 'inline', store: null as never },
      { name: 'onboarding_get', enabled: true },
    );
    const r = (await t.run(
      { guild_id: '999000999000999000' },
      { signal: new AbortController().signal },
    )) as {
      isError: boolean;
      structuredContent: { enabled: boolean; untrusted_text: string };
    };
    expect(r.isError).toBe(false);
    expect(r.structuredContent.enabled).toBe(true);
    expect(r.structuredContent.untrusted_text).toContain('untrusted_discord_channel_topic');
    expect(r.structuredContent.untrusted_text).toContain('Welcome!');
    expect(r.structuredContent.untrusted_text).toContain('Option A');
  });
});
