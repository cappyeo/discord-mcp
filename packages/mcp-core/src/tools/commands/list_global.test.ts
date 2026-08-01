import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import commandsListGlobal from './list_global.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';

describe('commands_list_global', () => {
  it('lists global commands with optional localizations query', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    server.use(
      http.get(`${DISCORD_API}/applications/:appId/commands`, ({ request, params }) => {
        const url = new URL(request.url);
        expect(url.searchParams.get('with_localizations')).toBe('true');
        return HttpResponse.json([
          {
            id: 'cmd_global_1',
            application_id: params.appId,
            name: 'help',
            description: 'Show help',
            type: 1,
          },
        ]);
      }),
    );
    const t = new commandsListGlobal(
      { name: 'commands_list_global', path: 'inline', root: 'inline', store: null as never },
      { name: 'commands_list_global', enabled: true },
    );
    const r = (await t.run(
      { application_id: '111111111111111111', with_localizations: true },
      { signal: new AbortController().signal },
    )) as {
      isError: boolean;
      structuredContent: {
        commands: Array<{ id: string; name: string }>;
        count: number;
        untrusted_text: string;
      };
    };
    expect(r.isError).toBe(false);
    expect(r.structuredContent.count).toBe(1);
    expect(r.structuredContent.commands[0]!.name).toBe('help');
    expect(r.structuredContent.untrusted_text).toContain('untrusted_discord_channel_topic');
  });
});
