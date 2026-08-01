import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import channelsModify from './modify.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';

describe('channels_modify', () => {
  it('PATCHes the channel and returns the updated record', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    let receivedBody: unknown = null;
    server.use(
      http.patch(`${DISCORD_API}/channels/:channelId`, async ({ params, request }) => {
        receivedBody = await request.json();
        return HttpResponse.json({
          id: params.channelId,
          name: 'general-2',
          type: 0,
          parent_id: null,
        });
      }),
    );
    const T = channelsModify;
    const t = new T(
      { name: 'channels_modify', path: 'inline', root: 'inline', store: null as never },
      { name: 'channels_modify', enabled: true },
    );
    const r = (await t.run(
      { channel_id: '111122223333444401', name: 'general-2', rate_limit_per_user: 5 },
      { signal: new AbortController().signal },
    )) as {
      isError: boolean;
      structuredContent: { id: string; name: string };
    };
    expect(r.isError).toBe(false);
    expect(r.structuredContent.name).toBe('general-2');
    expect(receivedBody).toMatchObject({ name: 'general-2', rate_limit_per_user: 5 });
  });
});
