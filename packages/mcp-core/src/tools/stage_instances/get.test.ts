import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import stageInstancesGet from './get.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';

describe('stage_instances_get', () => {
  it('GETs /stage-instances/:cid and wraps topic', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    server.use(
      http.get(`${DISCORD_API}/stage-instances/:cid`, ({ params }) => {
        return HttpResponse.json({
          id: '777777777777777777',
          guild_id: '999000999000999000',
          channel_id: params.cid,
          topic: 'live talk',
          privacy_level: 2,
        });
      }),
    );
    const T = stageInstancesGet;
    const t = new T(
      { name: 'stage_instances_get', path: 'inline', root: 'inline', store: null as never },
      { name: 'stage_instances_get', enabled: true },
    );
    const r = (await t.run(
      { channel_id: '111122223333444455' },
      { signal: new AbortController().signal },
    )) as {
      isError: boolean;
      structuredContent: { topic: string; untrusted_text: string };
    };
    expect(r.isError).toBe(false);
    expect(r.structuredContent.topic).toBe('live talk');
    expect(r.structuredContent.untrusted_text).toContain('untrusted_discord_channel_topic');
    expect(r.structuredContent.untrusted_text).toContain('live talk');
  });
});
