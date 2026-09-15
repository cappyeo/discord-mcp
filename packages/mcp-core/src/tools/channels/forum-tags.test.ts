import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { Tool } from '../../pieces/Tool.js';
import createChannel from './create_guild_channel.js';
import createThread from './forum_create_thread.js';
import get from './get.js';
import list from './list.js';
import active from './list_active_threads_guild.js';
import joined from './list_joined_private_archived_threads.js';
import privateArchived from './list_private_archived_threads.js';
import publicArchived from './list_public_archived_threads.js';
import '../../container.js';

const API = 'https://discord.com/api/v10';
const CHANNEL = '111122223333444455';
const GUILD = '999000999000999000';
const tags = [
  {
    id: '111122223333444401',
    name: 'Help',
    moderated: true,
    emoji_id: '111122223333444402',
    emoji_name: null,
  },
  { id: '111122223333444403', name: 'Done', moderated: false, emoji_id: null, emoji_name: '✅' },
  { id: '111122223333444404', name: 'Other', moderated: false, emoji_id: null, emoji_name: null },
];

async function run(T: typeof Tool, args: Record<string, unknown>) {
  const tool = new T(
    { name: T.name, path: 'inline', root: 'inline', store: null as never },
    { name: T.name, enabled: true },
  );
  const result = (await tool.run(args, { signal: new AbortController().signal })) as {
    isError: boolean;
    structuredContent: Record<string, unknown>;
  };
  expect(result.isError).toBe(false);
  // Exercise the published schema too: undeclared nested fields would be stripped.
  const parsed = z.object(tool.outputSchema!).parse(result.structuredContent);
  expect(parsed).toEqual(result.structuredContent);
  return parsed;
}

beforeEach(() => {
  container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token');
});

describe('forum tag output preservation', () => {
  it.each([
    15, 16,
  ])('returns every tag field for channel type %i, including on create/list', async (type) => {
    const channel = { id: CHANNEL, name: 'forum', type, position: 0, available_tags: tags };
    server.use(
      http.get(`${API}/channels/:id`, () => HttpResponse.json(channel)),
      http.get(`${API}/guilds/:id/channels`, () => HttpResponse.json([channel])),
      http.post(`${API}/guilds/:id/channels`, () => HttpResponse.json(channel)),
    );
    expect((await run(get, { channel_id: CHANNEL })).available_tags).toEqual(tags);
    const listed = await run(list, { guild_id: GUILD });
    expect((listed.channels as Record<string, unknown>[])[0].available_tags).toEqual(tags);
    expect(
      (await run(createChannel, { guild_id: GUILD, name: 'forum', type })).available_tags,
    ).toEqual(tags);
  });

  it.each([
    { applied_tags: [] },
    { applied_tags: [tags[0].id, tags[1].id] },
  ])('preserves applied_tags $applied_tags on post reads, creates, and every thread list', async ({
    applied_tags,
  }) => {
    const thread = { id: CHANNEL, name: 'old-post', type: 11, applied_tags };
    server.use(
      http.get(`${API}/channels/:id`, () => HttpResponse.json(thread)),
      http.get(`${API}/guilds/:id/threads/active`, () => HttpResponse.json({ threads: [thread] })),
      http.get(`${API}/channels/:id/threads/archived/:kind`, () =>
        HttpResponse.json({ threads: [thread] }),
      ),
      http.get(`${API}/channels/:id/users/@me/threads/archived/private`, () =>
        HttpResponse.json({ threads: [thread] }),
      ),
      http.post(`${API}/channels/:id/threads`, () => HttpResponse.json(thread)),
    );
    expect((await run(get, { channel_id: CHANNEL })).applied_tags).toEqual(applied_tags);
    expect(
      (
        await run(createThread, {
          channel_id: CHANNEL,
          name: 'post',
          message: { content: 'hello' },
        })
      ).applied_tags,
    ).toEqual(applied_tags);
    for (const T of [active, publicArchived, privateArchived, joined]) {
      const result = await run(T, { channel_id: CHANNEL, guild_id: GUILD });
      expect((result.threads as Record<string, unknown>[])[0].applied_tags).toEqual(applied_tags);
    }
  });

  it('distinguishes an empty tag set from an unavailable field', async () => {
    let available_tags: typeof tags | undefined = [];
    server.use(
      http.get(`${API}/channels/:id`, () =>
        HttpResponse.json({
          id: CHANNEL,
          name: 'forum',
          type: 15,
          available_tags,
        }),
      ),
    );
    expect((await run(get, { channel_id: CHANNEL })).available_tags).toEqual([]);
    available_tags = undefined;
    const result = await run(get, { channel_id: CHANNEL });
    expect(result).not.toHaveProperty('available_tags');
    expect(result).not.toHaveProperty('applied_tags');
  });
});
