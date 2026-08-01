import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import stageInstancesModify from './modify.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';

describe('stage_instances_modify', () => {
  it('PATCHes /stage-instances/:cid and wraps topic', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    server.use(
      http.patch(`${DISCORD_API}/stage-instances/:cid`, async ({ params, request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({
          id: '777777777777777777',
          guild_id: '999000999000999000',
          channel_id: params.cid,
          topic: (body.topic as string) ?? 'old',
          privacy_level: 2,
        });
      }),
    );
    const T = stageInstancesModify;
    const t = new T(
      { name: 'stage_instances_modify', path: 'inline', root: 'inline', store: null as never },
      { name: 'stage_instances_modify', enabled: true },
    );
    const r = (await t.run(
      { channel_id: '111122223333444455', topic: 'updated' },
      { signal: new AbortController().signal },
    )) as {
      isError: boolean;
      structuredContent: { topic: string; untrusted_text: string };
    };
    expect(r.isError).toBe(false);
    expect(r.structuredContent.topic).toBe('updated');
    expect(r.structuredContent.untrusted_text).toContain('untrusted_discord_channel_topic');
  });
});
