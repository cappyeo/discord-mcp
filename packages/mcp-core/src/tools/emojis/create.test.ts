import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import emojisCreate from './create.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';

describe('emojis_create', () => {
  it('POSTs the emoji body and returns the new emoji', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    server.use(
      http.post(`${DISCORD_API}/guilds/:guildId/emojis`, async ({ request }) => {
        const body = (await request.json()) as { name: string };
        return HttpResponse.json({
          id: '850000000000000099',
          name: body.name,
          animated: false,
          roles: [],
        });
      }),
    );
    const T = emojisCreate;
    const t = new T(
      { name: 'emojis_create', path: 'inline', root: 'inline', store: null as never },
      { name: 'emojis_create', enabled: true },
    );
    const r = (await t.run(
      {
        guild_id: '999000999000999000',
        name: 'sparkle',
        image: 'data:image/png;base64,iVBORw0KG',
      },
      { signal: new AbortController().signal },
    )) as { isError: boolean; structuredContent: { id: string; name: string } };
    expect(r.isError).toBe(false);
    expect(r.structuredContent.id).toBe('850000000000000099');
    expect(r.structuredContent.name).toBe('sparkle');
  });
});
