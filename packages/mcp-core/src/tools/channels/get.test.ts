import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import channelsGet from './get.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';

function outputShape(): Record<string, z.ZodTypeAny> {
  const meta = (
    channelsGet as unknown as { __toolMetadata: { outputSchema: Record<string, z.ZodTypeAny> } }
  ).__toolMetadata;
  return meta.outputSchema;
}

async function runGet(channelId: string): Promise<{
  isError: boolean;
  content: Array<{ text: string }>;
  structuredContent: Record<string, unknown>;
}> {
  const T = channelsGet;
  const t = new T(
    { name: 'channels_get', path: 'inline', root: 'inline', store: null as never },
    { name: 'channels_get', enabled: true },
  );
  return (await t.run(
    { channel_id: channelId },
    { signal: new AbortController().signal },
  )) as never;
}

describe('channels_get', () => {
  it('returns full channel record', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken(
      'fake-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    );
    const r = await runGet('111122223333444455');
    expect(r.isError).toBe(false);
    expect(r.structuredContent.id).toBe('111122223333444455');
    expect(r.structuredContent.name).toBe('general');
    expect(r.structuredContent.topic).toBe('Main discussion');
  });

  // MCP SDK >= 1.20 clients validate structuredContent against the published
  // outputSchema, so a schema stricter than Discord's real payload throws
  // client-side on a call that succeeded.
  it('parses a public thread that carries no position/parent_id', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken(
      'fake-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    );
    server.use(
      http.get(`${DISCORD_API}/channels/:channelId`, ({ params }) =>
        // Realistic APIThreadChannel: no `position` (not an APISortableChannel).
        HttpResponse.json({
          id: params.channelId,
          type: 11,
          name: 'help-thread',
          guild_id: '999000999000999000',
          owner_id: '111122223333444401',
          thread_metadata: { archived: false, locked: false, auto_archive_duration: 1440 },
        }),
      ),
    );
    const r = await runGet('111122223333444466');
    expect(r.isError).toBe(false);
    expect(r.structuredContent.position).toBeUndefined();
    expect(r.structuredContent.parent_id).toBeUndefined();
    expect(() => z.object(outputShape()).parse(r.structuredContent)).not.toThrow();
  });

  it('parses a DM whose name is null and does not render "#null"', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken(
      'fake-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    );
    server.use(
      http.get(`${DISCORD_API}/channels/:channelId`, ({ params }) =>
        // Realistic APIDMChannel: `name` is always null, no position/parent_id/guild_id.
        HttpResponse.json({
          id: params.channelId,
          type: 1,
          name: null,
          last_message_id: '111122223333444402',
          recipients: [{ id: '111122223333444403', username: 'alice' }],
        }),
      ),
    );
    const r = await runGet('111122223333444477');
    expect(r.isError).toBe(false);
    expect(r.structuredContent.name).toBeNull();
    expect(r.content[0].text).not.toContain('#null');
    expect(() => z.object(outputShape()).parse(r.structuredContent)).not.toThrow();
  });
});
