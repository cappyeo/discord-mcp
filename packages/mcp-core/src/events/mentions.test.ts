import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { guildMessageTypes } from './contract.js';
import { DmEventRuntime, type IncomingDm } from './runtime.js';

const describePosix = describe.skipIf(process.platform === 'win32');

const author = '111122223333444481',
  bot = '111122223333444482',
  channel = '111122223333444483',
  guild = '111122223333444484',
  otherAuthor = '111122223333444485';
const secret = `whsec_${Buffer.alloc(32, 7).toString('base64')}`;
const dmArgs = {
  name: 'message.created',
  arguments: { author_id: author },
  delivery: { mode: 'webhook', url: 'https://callback.example.test/dm', secret },
};
const args = {
  name: 'message.mentioned',
  arguments: { guild_id: guild },
  delivery: { mode: 'webhook', url: 'https://callback.example.test/mentions', secret },
};
const mention: IncomingDm = {
  id: '111122223333444486',
  channel_id: channel,
  author: { id: otherAuthor, bot: false },
  timestamp: new Date().toISOString(),
  content: `<@${bot}> Hello`,
  guild_id: guild,
  channel_type: 0,
  type: 0,
  mentioned_user_ids: [bot],
};
const dirs: string[] = [];
const runtimes: DmEventRuntime[] = [];
afterEach(() => {
  for (const r of runtimes.splice(0)) {
    try {
      r.close();
    } catch {}
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function setup(guildId: string | undefined = guild, existingDirectory?: string) {
  const directory = existingDirectory ?? mkdtempSync(join(tmpdir(), 'discord-mentions-'));
  if (!existingDirectory) dirs.push(directory);
  const rest = {
    get: vi.fn(async (path: string) =>
      path.endsWith(channel)
        ? { id: channel, type: 0, guild_id: guild }
        : [
            {
              id: '111122223333444487',
              author: { id: otherAuthor },
              content: 'Earlier context',
              timestamp: mention.timestamp,
            },
          ],
    ),
    post: vi.fn(async () => ({ id: '111122223333444488', channel_id: channel })),
  };
  const post = vi.fn(async (_url: string, body: string) => ({
    status: 200,
    body: JSON.stringify({ challenge: JSON.parse(body).challenge }),
  }));
  const options = {
    directory,
    owner: 'operator',
    authorId: author,
    botId: bot,
    ...(guildId ? { guildId } : {}),
    rest,
    post,
  };
  const runtime = new DmEventRuntime(options);
  runtimes.push(runtime);
  return { runtime, options, rest, post };
}
describePosix('guild mention filtering and subscription isolation', () => {
  it('advertises one fixed guild and accepts any human only on an actual direct mention', async () => {
    const s = setup();
    const list = await s.runtime.call('operator', 'events/list', {});
    expect(list.events).toMatchObject([
      { name: 'message.created' },
      { name: 'message.mentioned', inputSchema: { properties: { guild_id: { const: guild } } } },
    ]);
    await s.runtime.call('operator', 'events/subscribe', args);
    expect(await s.runtime.observe(mention)).toBe(true);
    expect(await s.runtime.observe(mention)).toBe(false);
    await s.runtime.deliver();
    expect(s.runtime.status().delivery).toMatchObject([
      { id: `discord_mention_${mention.id}`, state: 'delivered' },
    ]);
    const data = JSON.parse(s.post.mock.calls.at(-1)![1]);
    expect(data).toMatchObject({
      name: 'message.mentioned',
      data: {
        guild_id: guild,
        channel_id: channel,
        author_id: otherAuthor,
        mentioned_bot_id: bot,
        text: mention.content,
      },
    });
  });
  it('ignores other guilds, untagged text, fake/display-name/role/everyone tags, implicit replies, bots and webhooks', async () => {
    const s = setup();
    await s.runtime.call('operator', 'events/subscribe', args);
    for (const change of [
      { guild_id: '999988887777666655' },
      { guild_id: undefined },
      { content: 'Hello @Zoltan', mentioned_user_ids: [] },
      { content: `<@${bot}> Hello`, mentioned_user_ids: [] },
      { content: `<@&${bot}> Hello`, mentioned_user_ids: [] },
      { content: '@everyone Hello', mentioned_user_ids: [] },
      { content: 'Reply to your message', mentioned_user_ids: [bot], type: 19 },
      { author: { id: bot } },
      { author: { id: otherAuthor, bot: true } },
      { webhook_id: '999988887777666655' },
      { channel_type: 3 },
      { channel_type: 4 },
      { attachments: [{}] },
      { type: 20 },
    ])
      expect(await s.runtime.observe({ ...mention, ...change })).toBe(false);
    expect(s.runtime.status().delivery).toHaveLength(0);
  });
  it('rejects oversized or invalid incoming data without crashing the shared DM listener', async () => {
    const s = setup();
    await s.runtime.call('operator', 'events/subscribe', args);
    expect(await s.runtime.observe({ ...mention, content: `<@${bot}>${'x'.repeat(5000)}` })).toBe(
      false,
    );
    expect(await s.runtime.observe({ ...mention, timestamp: 'invalid' })).toBe(false);
    expect(await s.runtime.observe(mention)).toBe(true);
  });
  it('covers every message-bearing channel type and accessible threads without a frozen channel-ID list', async () => {
    const s = setup();
    await s.runtime.call('operator', 'events/subscribe', args);
    for (const [index, type] of guildMessageTypes.entries())
      expect(
        await s.runtime.observe({
          ...mention,
          id: String(BigInt(mention.id) + BigInt(index)),
          channel_id: String(BigInt(channel) + BigInt(index)),
          channel_type: type,
        }),
      ).toBe(true);
    expect(s.runtime.status().delivery).toHaveLength(guildMessageTypes.length);
  });
  it('rejects disabled/wrong guild filters, author filters and foreign owners', async () => {
    const s = setup('');
    expect((await s.runtime.call('operator', 'events/list', {})).events).toHaveLength(1);
    await expect(s.runtime.call('operator', 'events/subscribe', args)).rejects.toMatchObject({
      code: -32001,
    });
    const t = setup();
    for (const input of [
      { ...args, arguments: { guild_id: '999988887777666655' } },
      { ...args, arguments: { guild_id: guild, author_id: author } },
      { ...args, arguments: { author_id: author } },
    ])
      await expect(t.runtime.call('operator', 'events/subscribe', input)).rejects.toBeDefined();
    await expect(t.runtime.call('stranger', 'events/subscribe', args)).rejects.toMatchObject({
      code: -32001,
    });
  });
  it('retains the existing DM subscription identity alongside an independent mention subscription', async () => {
    const s = setup();
    const dm = await s.runtime.call('operator', 'events/subscribe', dmArgs);
    const mentioned = await s.runtime.call('operator', 'events/subscribe', args);
    expect(mentioned.id).not.toBe(dm.id);
    await s.runtime.call('operator', 'events/subscribe', dmArgs);
    await expect(
      s.runtime.call('operator', 'events/subscribe', {
        ...args,
        delivery: { ...args.delivery, url: 'https://other.example.test' },
      }),
    ).rejects.toMatchObject({ code: -32001 });
    await s.runtime.call('operator', 'events/unsubscribe', {
      ...args,
      delivery: { mode: 'webhook', url: args.delivery.url },
    });
    expect(await s.runtime.observe(mention)).toBe(false);
    expect(
      await s.runtime.observe({
        ...mention,
        id: '111122223333444489',
        guild_id: undefined,
        channel_type: 1,
        author: { id: author },
        content: 'DM preserved',
      }),
    ).toBe(true);
    await s.runtime.deliver();
    expect(s.runtime.status().delivery).toMatchObject([{ state: 'delivered' }]);
  });
  it('recovers a queued mention and both active subscriptions across restart', async () => {
    const s = setup();
    await s.runtime.call('operator', 'events/subscribe', dmArgs);
    await s.runtime.call('operator', 'events/subscribe', args);
    await s.runtime.observe(mention);
    s.runtime.close();
    const restarted = new DmEventRuntime(s.options);
    runtimes.push(restarted);
    await restarted.deliver();
    expect(restarted.status().subscriptions).toHaveLength(2);
    expect(restarted.status().delivery).toMatchObject([{ state: 'delivered', attempts: 1 }]);
  });
});
describePosix('conversation-bound guild replies and context', () => {
  it('reads shared history only from the accepted channel, replies there once and preserves the reference', async () => {
    const s = setup();
    await s.runtime.call('operator', 'events/subscribe', args);
    await s.runtime.observe(mention);
    await s.runtime.deliver();
    const context = await s.runtime.call('operator', 'message/context', {
      event_id: `discord_mention_${mention.id}`,
      limit: 20,
    });
    expect(context).toMatchObject({
      guild_id: guild,
      channel_id: channel,
      messages: [{ author_id: otherAuthor, text: 'Earlier context' }],
    });
    const reply = { event_id: `discord_mention_${mention.id}`, content: 'Hello there' };
    expect(await s.runtime.call('operator', 'message/reply', reply)).toMatchObject({
      status: 'sent',
      channel_id: channel,
    });
    expect(await s.runtime.call('operator', 'message/reply', reply)).toMatchObject({
      status: 'sent',
    });
    expect(s.rest.post).toHaveBeenCalledTimes(1);
    expect(s.rest.post.mock.calls[0]).toMatchObject([
      `/channels/${channel}/messages`,
      {
        body: {
          message_reference: { message_id: mention.id, channel_id: channel },
          allowed_mentions: { parse: [], replied_user: false },
        },
      },
    ]);
    await expect(
      s.runtime.call('operator', 'message/reply', { ...reply, channel_id: '999988887777666655' }),
    ).rejects.toBeDefined();
    await expect(
      s.runtime.call('operator', 'message/reply', { ...reply, content: 'Changed' }),
    ).rejects.toBeDefined();
  });
  it('DM-specific tools cannot access guild events and revoked/wrong channel scope prevents writes', async () => {
    const s = setup();
    await s.runtime.call('operator', 'events/subscribe', args);
    await s.runtime.observe(mention);
    await s.runtime.deliver();
    const input = { event_id: `discord_mention_${mention.id}`, content: 'Hi' };
    await expect(
      s.runtime.call('operator', 'dm/context', { event_id: input.event_id }),
    ).rejects.toMatchObject({ code: -32001 });
    await expect(s.runtime.call('operator', 'dm/reply', input)).rejects.toMatchObject({
      code: -32001,
    });
    s.rest.get.mockResolvedValueOnce({
      id: channel,
      type: 0,
      guild_id: '999988887777666655',
    } as never);
    await expect(s.runtime.call('operator', 'message/reply', input)).rejects.toMatchObject({
      code: -32001,
    });
    expect(s.rest.post).not.toHaveBeenCalled();
    s.rest.get.mockRejectedValueOnce({ status: 403 });
    await expect(
      s.runtime.call('operator', 'message/context', { event_id: input.event_id }),
    ).rejects.toBeDefined();
  });
  it('never blindly resends an ambiguous guild reply after restart', async () => {
    const s = setup();
    await s.runtime.call('operator', 'events/subscribe', args);
    await s.runtime.observe(mention);
    await s.runtime.deliver();
    s.rest.post.mockRejectedValueOnce(new Error('Lost response'));
    const input = { event_id: `discord_mention_${mention.id}`, content: 'Hi' };
    expect(await s.runtime.call('operator', 'message/reply', input)).toMatchObject({
      status: 'needs_review',
    });
    s.runtime.close();
    const restarted = new DmEventRuntime(s.options);
    runtimes.push(restarted);
    expect(await restarted.call('operator', 'message/reply', input)).toMatchObject({
      status: 'needs_review',
    });
    expect(s.rest.post).toHaveBeenCalledTimes(1);
  });
});
it.skipIf(process.platform === 'win32')(
  'migrates DM-only storage without changing its table shape, identity or queued payload',
  async () => {
    const directory = mkdtempSync(join(tmpdir(), 'discord-legacy-state-'));
    dirs.push(directory);
    const db = new DatabaseSync(join(directory, 'events.sqlite'));
    db.exec(
      'CREATE TABLE subscriptions (id TEXT PRIMARY KEY, owner TEXT, author TEXT, url TEXT, secret TEXT, expires INTEGER, state TEXT, verified INTEGER, old_secret TEXT, rotate_until INTEGER); CREATE TABLE events (id TEXT PRIMARY KEY,sub_id TEXT,body TEXT,state TEXT,attempts INTEGER,next INTEGER,status INTEGER);',
    );
    const id = `sub_${createHash('sha256')
      .update(JSON.stringify(['operator', dmArgs.delivery.url, dmArgs.name, dmArgs.arguments]))
      .digest('hex')}`;
    db.prepare('INSERT INTO subscriptions VALUES (?,?,?,?,?,?,?,?,?,?)').run(
      id,
      'operator',
      author,
      dmArgs.delivery.url,
      secret,
      Date.now() + 86400000,
      'active',
      Date.now(),
      '',
      0,
    );
    const body = {
      eventId: 'discord_dm_111122223333444490',
      name: 'message.created',
      timestamp: mention.timestamp,
      data: {
        message_id: '111122223333444490',
        channel_id: channel,
        author_id: author,
        timestamp: mention.timestamp,
        text: 'Existing queued DM',
        reply_reference: null,
      },
      cursor: null,
    };
    db.prepare("INSERT INTO events VALUES (?,?,?,'pending',0,?,NULL)").run(
      body.eventId,
      id,
      JSON.stringify(body),
      Date.now(),
    );
    db.close();
    const s = setup(guild, directory);
    expect((await s.runtime.call('operator', 'events/subscribe', dmArgs)).id).toBe(id);
    await s.runtime.deliver();
    expect(s.runtime.status().delivery).toMatchObject([{ id: body.eventId, state: 'delivered' }]);
    expect(s.runtime.db.prepare('PRAGMA table_info(subscriptions)').all()).toHaveLength(10);
  },
);
