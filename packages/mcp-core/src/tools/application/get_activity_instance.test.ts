import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import applicationGetActivityInstance from './get_activity_instance.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';

describe('application_get_activity_instance', () => {
  it('GETs an activity instance by id', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    server.use(
      http.get(`${DISCORD_API}/applications/:appId/activity-instances/:instId`, ({ params }) =>
        HttpResponse.json({
          application_id: params.appId,
          instance_id: params.instId,
          launch_id: 'launch-1',
          users: ['111111111111111111'],
        }),
      ),
    );
    const t = new applicationGetActivityInstance(
      {
        name: 'application_get_activity_instance',
        path: 'inline',
        root: 'inline',
        store: null as never,
      },
      { name: 'application_get_activity_instance', enabled: true },
    );
    const r = (await t.run(
      { application_id: '111111111111111111', instance_id: 'inst-abc' },
      { signal: new AbortController().signal },
    )) as {
      isError: boolean;
      structuredContent: { instance_id: string; users?: string[] };
    };
    expect(r.isError).toBe(false);
    expect(r.structuredContent.instance_id).toBe('inst-abc');
    expect(r.structuredContent.users).toEqual(['111111111111111111']);
  });
});
