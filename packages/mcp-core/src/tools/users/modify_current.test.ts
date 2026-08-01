import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import usersModifyCurrent from './modify_current.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';

describe('users_modify_current', () => {
  // Routes.user('@me') goes through runtime param substitution → URL-encodes @me to %40me.
  it('PATCHes /users/%40me with the new username', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    let capturedUrl: string | null = null;
    server.use(
      http.patch(`${DISCORD_API}/users/%40me`, async ({ request }) => {
        capturedUrl = request.url;
        const body = (await request.json()) as { username?: string };
        expect(body.username).toBe('discord-mcp-bot-renamed');
        return HttpResponse.json({
          id: '111122223333444499',
          username: body.username,
          global_name: 'Discord MCP Bot',
          avatar: null,
          banner: null,
          bot: true,
        });
      }),
    );
    const T = usersModifyCurrent;
    const t = new T(
      { name: 'users_modify_current', path: 'inline', root: 'inline', store: null as never },
      { name: 'users_modify_current', enabled: true },
    );
    const r = (await t.run(
      { username: 'discord-mcp-bot-renamed' },
      { signal: new AbortController().signal },
    )) as { isError: boolean; structuredContent: { id: string; username: string } };
    expect(r.isError).toBe(false);
    expect(r.structuredContent.username).toBe('discord-mcp-bot-renamed');
    expect(capturedUrl).toContain('/users/%40me');
  });
});
