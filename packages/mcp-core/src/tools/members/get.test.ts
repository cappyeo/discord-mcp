import { server } from '@cappyeo/discord-mcp-server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import membersGet from './get.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';

function outputShape(): Record<string, z.ZodTypeAny> {
  return (
    membersGet as unknown as { __toolMetadata: { outputSchema: Record<string, z.ZodTypeAny> } }
  ).__toolMetadata.outputSchema;
}

async function runGet(): Promise<{
  isError: boolean;
  content: Array<{ text: string }>;
  structuredContent: Record<string, unknown>;
}> {
  const T = membersGet;
  const t = new T(
    { name: 'members_get', path: 'inline', root: 'inline', store: null as never },
    { name: 'members_get', enabled: true },
  );
  return (await t.run(
    { guild_id: '999000999000999000', user_id: '111122223333444455' },
    { signal: new AbortController().signal },
  )) as never;
}

describe('members_get', () => {
  it('returns member profile with wrapped nick', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken(
      'fake-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    );
    const r = await runGet();
    expect(r.isError).toBe(false);
    expect(r.structuredContent.user_id).toBe('111122223333444455');
    expect(r.structuredContent.username).toBe('alice');
    expect(r.structuredContent.roles).toEqual(['100000106195174251', '100000106195175228']);
  });

  // MCP SDK >= 1.20 clients validate structuredContent against the published
  // outputSchema; Discord omits premium_since/pending and may null joined_at.
  it('parses a member with no premium_since/pending and a null joined_at', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken(
      'fake-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    );
    server.use(
      http.get(`${DISCORD_API}/guilds/:guildId/members/:userId`, ({ params }) =>
        HttpResponse.json({
          user: {
            id: params.userId,
            username: 'bob',
            discriminator: '0',
            global_name: null,
            avatar: null,
          },
          nick: null,
          roles: [],
          joined_at: null,
          flags: 0,
        }),
      ),
    );
    const r = await runGet();
    expect(r.isError).toBe(false);
    expect(r.structuredContent.joined_at).toBeNull();
    expect(r.structuredContent.premium_since).toBeUndefined();
    expect(r.structuredContent.pending).toBeUndefined();
    expect(() => z.object(outputShape()).parse(r.structuredContent)).not.toThrow();
  });
});
