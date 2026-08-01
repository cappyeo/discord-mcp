import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import stageInstancesCreate from './create.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';

describe('stage_instances_create', () => {
  it('POSTs /stage-instances and returns the new instance', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    server.use(
      http.post(`${DISCORD_API}/stage-instances`, async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({
          id: '777777777777777777',
          guild_id: '999000999000999000',
          channel_id: body.channel_id,
          topic: body.topic,
          privacy_level: body.privacy_level ?? 2,
        });
      }),
    );
    const T = stageInstancesCreate;
    const t = new T(
      { name: 'stage_instances_create', path: 'inline', root: 'inline', store: null as never },
      { name: 'stage_instances_create', enabled: true },
    );
    const r = (await t.run(
      { channel_id: '111122223333444455', topic: 'AMA' },
      { signal: new AbortController().signal },
    )) as { isError: boolean; structuredContent: { id: string; topic: string } };
    expect(r.isError).toBe(false);
    expect(r.structuredContent.id).toBe('777777777777777777');
    expect(r.structuredContent.topic).toBe('AMA');
  });
});
