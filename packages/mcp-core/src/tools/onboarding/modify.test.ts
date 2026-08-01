import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import onboardingModify from './modify.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';

describe('onboarding_modify', () => {
  it('PUTs /guilds/:gid/onboarding', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    server.use(
      http.put(`${DISCORD_API}/guilds/:gid/onboarding`, async ({ params, request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({
          guild_id: params.gid,
          enabled: body.enabled as boolean,
          mode: body.mode as number,
        });
      }),
    );
    const T = onboardingModify;
    const t = new T(
      { name: 'onboarding_modify', path: 'inline', root: 'inline', store: null as never },
      { name: 'onboarding_modify', enabled: true },
    );
    const r = (await t.run(
      {
        guild_id: '999000999000999000',
        prompts: [],
        default_channel_ids: [],
        enabled: true,
        mode: 0,
      },
      { signal: new AbortController().signal },
    )) as { isError: boolean; structuredContent: { enabled: boolean; mode: number } };
    expect(r.isError).toBe(false);
    expect(r.structuredContent.enabled).toBe(true);
    expect(r.structuredContent.mode).toBe(0);
  });
});
