import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import commandsGetGlobal from './get_global.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';

describe('commands_get_global', () => {
  it('GETs single global command and wraps name/description', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    server.use(
      http.get(`${DISCORD_API}/applications/:appId/commands/:cmdId`, ({ params }) =>
        HttpResponse.json({
          id: params.cmdId,
          application_id: params.appId,
          name: 'help',
          description: 'Show help',
          type: 1,
        }),
      ),
    );
    const t = new commandsGetGlobal(
      { name: 'commands_get_global', path: 'inline', root: 'inline', store: null as never },
      { name: 'commands_get_global', enabled: true },
    );
    const r = (await t.run(
      { application_id: '111111111111111111', command_id: '222222222222222222' },
      { signal: new AbortController().signal },
    )) as {
      isError: boolean;
      structuredContent: { name: string; untrusted_text: string };
    };
    expect(r.isError).toBe(false);
    expect(r.structuredContent.name).toBe('help');
    expect(r.structuredContent.untrusted_text).toContain('untrusted_discord_channel_topic');
  });
});
