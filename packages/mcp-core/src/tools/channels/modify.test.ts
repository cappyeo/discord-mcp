import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import channelsGet from './get.js';
import activeThreads from './list_active_threads_guild.js';
import archivedThreads from './list_public_archived_threads.js';
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

describe('channels_modify forum tag safety', () => {
  const CHANNEL = '111122223333444401';
  const POST = '111122223333444402';
  const GUILD = '999000999000999000';
  const TAG = '111122223333444403';
  const OTHER = '111122223333444404';
  const NEW = '111122223333444405';
  const EMOJI = '111122223333444406';
  const initialTags = [
    { id: TAG, name: 'Help', moderated: true, emoji_id: EMOJI, emoji_name: null },
    { id: OTHER, name: 'Done', moderated: false, emoji_id: null, emoji_name: '✅' },
  ];
  let state: Record<string, unknown>;
  let requests: string[];
  let patched: Record<string, unknown> | undefined;
  let tool: InstanceType<typeof channelsModify>;

  beforeEach(() => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token');
    state = { id: CHANNEL, name: 'forum', type: 15, available_tags: structuredClone(initialTags) };
    requests = [];
    patched = undefined;
    tool = new channelsModify(
      { name: 'channels_modify', path: 'inline', root: 'inline', store: null as never },
      { name: 'channels_modify', enabled: true },
    );
    server.use(
      http.get(`${DISCORD_API}/channels/${CHANNEL}`, () => {
        requests.push('GET');
        return HttpResponse.json(state);
      }),
      http.patch(`${DISCORD_API}/channels/${CHANNEL}`, async ({ request }) => {
        requests.push('PATCH');
        patched = (await request.json()) as Record<string, unknown>;
        state = { ...state, ...patched };
        if (Array.isArray(state.available_tags)) {
          state.available_tags = state.available_tags.map((tag) => ({ ...tag, id: tag.id ?? NEW }));
        }
        return HttpResponse.json(state);
      }),
    );
  });

  async function run(args: Record<string, unknown>) {
    const parsed = z.object(tool.inputSchema).parse({ channel_id: CHANNEL, ...args });
    return (await tool.run(parsed, { signal: new AbortController().signal })) as {
      isError: boolean;
      structuredContent: Record<string, unknown>;
    };
  }

  it('keeps tag IDs, emoji and moderation on rename, then reads back the forum and old posts', async () => {
    const post = () => ({
      id: POST,
      name: 'old-post',
      type: 11,
      parent_id: CHANNEL,
      // Model Discord retaining assignments only while the original IDs exist.
      applied_tags: [TAG, OTHER].filter((id) =>
        (state.available_tags as typeof initialTags).some((tag) => tag.id === id),
      ),
    });
    server.use(
      http.get(`${DISCORD_API}/channels/${POST}`, () => HttpResponse.json(post())),
      http.get(`${DISCORD_API}/guilds/${GUILD}/threads/active`, () =>
        HttpResponse.json({ threads: [post()] }),
      ),
      http.get(`${DISCORD_API}/channels/${CHANNEL}/threads/archived/public`, () =>
        HttpResponse.json({ threads: [post()], has_more: false }),
      ),
    );
    const result = await run({
      available_tags: [
        { id: TAG, name: 'Support' },
        { id: OTHER, name: 'Done' },
      ],
    });
    expect(requests).toEqual(['GET', 'PATCH', 'GET']);
    expect(patched).toEqual({
      available_tags: [{ ...initialTags[0], name: 'Support' }, initialTags[1]],
    });
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toMatchObject({
      tags_verified: true,
      available_tags: patched!.available_tags,
    });
    expect(z.object(tool.outputSchema!).parse(result.structuredContent)).toEqual(
      result.structuredContent,
    );
    for (const T of [channelsGet, activeThreads, archivedThreads]) {
      const reader = new T(
        { name: T.name, path: 'inline', root: 'inline', store: null as never },
        { name: T.name, enabled: true },
      );
      const read = (await reader.run(
        { channel_id: T === channelsGet ? POST : CHANNEL, guild_id: GUILD },
        { signal: new AbortController().signal },
      )) as { structuredContent: Record<string, unknown> };
      const oldPost =
        T === channelsGet
          ? read.structuredContent
          : (read.structuredContent.threads as Record<string, unknown>[])[0];
      expect(oldPost.applied_tags).toEqual([TAG, OTHER]);
    }
  });

  it('adds a tag without replacing existing IDs and returns the assigned ID', async () => {
    const result = await run({ available_tags: [...initialTags, { name: 'New' }] });
    expect((patched!.available_tags as Record<string, unknown>[])[2]).toEqual({
      name: 'New',
      moderated: false,
      emoji_id: null,
      emoji_name: null,
    });
    expect(result.structuredContent.available_tags).toEqual([
      ...initialTags,
      { id: NEW, name: 'New', moderated: false, emoji_id: null, emoji_name: null },
    ]);
    expect(result.structuredContent.tags_verified).toBe(true);
  });

  it('allows additions to a known empty set', async () => {
    state.available_tags = [];
    expect((await run({ available_tags: [{ name: 'New' }] })).isError).toBe(false);
  });

  it.each([
    { available_tags: [{ name: 'Replacement' }] },
    { available_tags: [initialTags[0]] },
    { available_tags: [] },
    { available_tags: [...initialTags, { id: NEW, name: 'Unknown' }] },
    { available_tags: [initialTags[0], initialTags[0], initialTags[1]] },
    { available_tags: initialTags, remove_available_tag_ids: [NEW] },
    { available_tags: initialTags, remove_available_tag_ids: [TAG] },
    { available_tags: [initialTags[0]], remove_available_tag_ids: [OTHER, OTHER] },
    { remove_available_tag_ids: [TAG] },
    { available_tags: initialTags, applied_tags: [] },
  ])('refuses ambiguous or inconsistent replacement %# before PATCH', async (args) => {
    await expect(run(args)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(patched).toBeUndefined();
  });

  it('removes only explicitly named IDs and never sends the guard field to Discord', async () => {
    const result = await run({
      available_tags: [initialTags[0]],
      remove_available_tag_ids: [OTHER],
    });
    expect(patched).toEqual({ available_tags: [initialTags[0]] });
    expect(result.structuredContent.tags_verified).toBe(true);
  });

  it('clears the full set only when every removal is explicit', async () => {
    const result = await run({ available_tags: [], remove_available_tag_ids: [TAG, OTHER] });
    expect(result.structuredContent).toMatchObject({ available_tags: [], tags_verified: true });
  });

  it.each([
    { available_tags: undefined },
    { available_tags: null },
    { available_tags: [{ id: TAG, name: 'Partial' }] },
  ])('blocks an unreadable or partial current set %#', async ({ available_tags }) => {
    state.available_tags = available_tags;
    await expect(run({ available_tags: [] })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(requests).toEqual(['GET']);
  });

  it('does not PATCH after a failed pre-read', async () => {
    server.use(
      http.get(`${DISCORD_API}/channels/${CHANNEL}`, () =>
        HttpResponse.json({ message: 'Missing Access', code: 50001 }, { status: 403 }),
      ),
    );
    await expect(run({ available_tags: initialTags })).rejects.toThrow();
    expect(patched).toBeUndefined();
  });

  it.each([
    { index: 0, emoji: { emoji_name: '🎉' }, expected: { emoji_id: null, emoji_name: '🎉' } },
    { index: 1, emoji: { emoji_id: EMOJI }, expected: { emoji_id: EMOJI, emoji_name: null } },
    {
      index: 0,
      emoji: { emoji_id: null, emoji_name: null },
      expected: { emoji_id: null, emoji_name: null },
    },
  ])('changes emoji without changing ID %#', async ({ index, emoji, expected }) => {
    const available_tags = initialTags.map(({ id, name }, i) => ({
      id,
      name,
      ...(i === index ? emoji : {}),
    }));
    const result = await run({ available_tags });
    expect((result.structuredContent.available_tags as Record<string, unknown>[])[index]).toEqual({
      ...initialTags[index],
      ...expected,
    });
  });

  it('rejects two non-null emoji fields before I/O', async () => {
    await expect(
      run({ available_tags: [{ ...initialTags[0], emoji_name: '✅' }, initialTags[1]] }),
    ).rejects.toThrow();
    expect(requests).toEqual([]);
  });

  it.each([
    'name',
    'moderated',
    'emoji_id',
    'emoji_name',
    'id',
    'missing',
    'duplicate',
    'extra',
    'unreadable',
    'failed-read',
  ])('reports a successful PATCH but failed %s verification without retrying', async (field) => {
    server.use(
      http.get(`${DISCORD_API}/channels/${CHANNEL}`, () => {
        requests.push('GET');
        if (!patched) return HttpResponse.json(state);
        if (field === 'failed-read')
          return HttpResponse.json({ message: 'Missing Access', code: 50001 }, { status: 403 });
        const altered = structuredClone(state) as { available_tags?: Record<string, unknown>[] };
        const tags = altered.available_tags!;
        if (field === 'missing') tags.pop();
        else if (field === 'duplicate') tags[1] = tags[0];
        else if (field === 'extra') tags.push({ ...initialTags[0], id: NEW });
        else if (field === 'unreadable') delete altered.available_tags;
        else
          tags[0][field] =
            field === 'moderated'
              ? false
              : field === 'id' || field === 'emoji_id'
                ? NEW
                : 'changed';
        return HttpResponse.json(altered);
      }),
    );
    const result = await run({ available_tags: initialTags });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      code: 'TAG_VERIFICATION_FAILED',
      patch_succeeded: true,
      retriable: false,
    });
    expect(result.structuredContent).not.toHaveProperty('tags_verified');
    expect(requests).toEqual(['GET', 'PATCH', 'GET']);
  });

  it.each([
    { applied_tags: [] },
    { applied_tags: [OTHER, TAG] },
  ])('reads, edits and verifies post tags $applied_tags', async ({ applied_tags }) => {
    state = { id: CHANNEL, name: 'post', type: 11, applied_tags: [TAG] };
    const result = await run({ applied_tags });
    expect(patched).toEqual({ applied_tags });
    expect(result.structuredContent).toMatchObject({ applied_tags, tags_verified: true });
    expect(requests).toEqual(['GET', 'PATCH', 'GET']);
  });

  it('refuses post tag changes when the current field is missing', async () => {
    await expect(run({ applied_tags: [] })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(patched).toBeUndefined();
  });

  it('reports a post tag readback mismatch', async () => {
    server.use(
      http.get(`${DISCORD_API}/channels/${CHANNEL}`, () =>
        HttpResponse.json({
          id: CHANNEL,
          type: 11,
          name: 'post',
          applied_tags: [TAG],
        }),
      ),
    );
    expect((await run({ applied_tags: [OTHER] })).structuredContent).toMatchObject({
      code: 'TAG_VERIFICATION_FAILED',
      patch_succeeded: true,
    });
  });
});
