import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Webhook } from 'standardwebhooks';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { callbackUrl, publicAddress, validateSecret, verifyCallback } from './callback.js';
import { DmEventRuntime, type IncomingDm } from './runtime.js';

const describePosix = describe.skipIf(process.platform === 'win32');

const author = '111122223333444481';
const bot = '111122223333444482';
const channel = '111122223333444483';
const secret = `whsec_${Buffer.alloc(32, 7).toString('base64')}`;
const args = {
  name: 'message.created',
  arguments: { author_id: author },
  delivery: { mode: 'webhook', url: 'https://callback.example.test/secret-path', secret },
};
const message: IncomingDm = {
  id: '111122223333444484',
  channel_id: channel,
  author: { id: author },
  timestamp: new Date().toISOString(),
  content: 'Hello',
  channel_type: 1,
  type: 0,
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
function setup(overrides: Partial<DmEventRuntime['options']> = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'discord-events-test-'));
  dirs.push(directory);
  let time = Date.now();
  let deliveryStatus = 200;
  const post = vi.fn(async (_url: string, body: string, headers: Record<string, string>) => {
    new Webhook(secret).verify(body, {
      'webhook-id': headers['webhook-id']!,
      'webhook-timestamp': headers['webhook-timestamp']!,
      'webhook-signature': headers['webhook-signature']!,
    });
    const data = JSON.parse(body);
    return {
      status: data.type === 'verification' ? 200 : deliveryStatus,
      body: JSON.stringify({ challenge: data.challenge }),
    };
  });
  const rest = {
    get: vi.fn(async (path: string) =>
      path.endsWith(channel) ? { id: channel, type: 1, recipients: [{ id: author }] } : [],
    ),
    post: vi.fn(async () => ({ id: '111122223333444485', channel_id: channel })),
  };
  const options = {
    directory,
    owner: 'operator',
    authorId: author,
    botId: bot,
    rest,
    post,
    now: () => time,
    ...overrides,
  };
  const runtime = new DmEventRuntime(options);
  runtimes.push(runtime);
  return {
    runtime,
    options,
    rest,
    post,
    advance: (ms: number) => {
      time += ms;
    },
    status: (s: number) => {
      deliveryStatus = s;
    },
  };
}
describePosix('bounded Events history', () => {
  it('bounds pending operations and drains already accepted work', async () => {
    const s = setup();
    let unblock!: () => void;
    const held = s.runtime.exclusive(
      () =>
        new Promise<void>((resolve) => {
          unblock = resolve;
        }),
    );
    await Promise.resolve();
    let finished = 0;
    const queued = Array.from({ length: 255 }, () =>
      s.runtime.exclusive(async () => {
        finished++;
      }),
    );
    await expect(s.runtime.call('operator', 'events/list', {})).rejects.toThrow('busy');
    const closing = s.runtime.closeWhenIdle();
    unblock();
    await Promise.all([held, ...queued, closing]);
    expect(finished).toBe(255);
    expect(() => s.runtime.status()).toThrow();
  });

  it('expires queued work before starting a late side effect', async () => {
    const s = setup();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(0);
    let unblock!: () => void;
    const effect = vi.fn(async () => {});
    try {
      const held = s.runtime.exclusive(
        () =>
          new Promise<void>((resolve) => {
            unblock = resolve;
          }),
      );
      await Promise.resolve();
      const queued = s.runtime.exclusive(effect);
      clock.mockReturnValue(30_001);
      unblock();
      await held;
      await expect(queued).rejects.toThrow('expired in queue');
      expect(effect).not.toHaveBeenCalled();
    } finally {
      clock.mockRestore();
    }
  });

  it('rejects new observations at capacity without discarding accepted or deduplicated events', async () => {
    const s = setup({ maxRecords: 1 });
    await s.runtime.call('operator', 'events/subscribe', args);
    expect(await s.runtime.observe(message)).toBe(true);
    expect(await s.runtime.observe(message)).toBe(false);
    await expect(s.runtime.observe({ ...message, id: '111122223333444489' })).rejects.toThrow(
      'capacity',
    );
    await s.runtime.deliver();
    expect(s.runtime.status().totals.events).toBe(1);
    expect(s.runtime.status().delivery).toMatchObject([{ state: 'delivered' }]);
  });

  it('prunes old acknowledged history and rejects re-observation after its dedupe window', async () => {
    const s = setup();
    await s.runtime.call('operator', 'events/subscribe', args);
    await s.runtime.observe(message);
    await s.runtime.deliver();
    await s.runtime.call('operator', 'dm/reply', {
      event_id: `discord_dm_${message.id}`,
      content: 'Reply',
    });
    s.advance(8 * 86_400_000);
    await s.runtime.deliver();
    expect(s.runtime.status().totals).toEqual({ events: 0, replies: 0 });
    await s.runtime.call('operator', 'events/subscribe', args);
    expect(await s.runtime.observe(message)).toBe(false);
  });

  it('retains uncertain sends across expiry and cleanup rather than enabling a duplicate reply', async () => {
    const s = setup();
    await s.runtime.call('operator', 'events/subscribe', args);
    await s.runtime.observe(message);
    await s.runtime.deliver();
    s.rest.post.mockRejectedValueOnce(new Error('connection reset after send'));
    expect(
      await s.runtime.call('operator', 'dm/reply', {
        event_id: `discord_dm_${message.id}`,
        content: 'Reply',
      }),
    ).toMatchObject({ status: 'needs_review' });
    s.advance(8 * 86_400_000);
    await s.runtime.deliver();
    expect(s.runtime.status().totals).toEqual({ events: 1, replies: 1 });
    expect(s.runtime.status().replies).toMatchObject([{ state: 'uncertain' }]);
    expect(s.rest.post).toHaveBeenCalledTimes(1);
  });

  it('bounds subscription churn and rejects future-dated observations', async () => {
    const s = setup();
    await s.runtime.call('operator', 'events/subscribe', args);
    expect(
      await s.runtime.observe({
        ...message,
        timestamp: new Date(Date.now() + 600_000).toISOString(),
      }),
    ).toBe(false);
    await s.runtime.call('operator', 'events/unsubscribe', {
      ...args,
      delivery: { mode: 'webhook', url: args.delivery.url },
    });
    for (let n = 1; n < 100; n++) {
      const next = {
        ...args,
        delivery: { ...args.delivery, url: `https://callback.example.test/${n}` },
      };
      await s.runtime.call('operator', 'events/subscribe', next);
      await s.runtime.call('operator', 'events/unsubscribe', {
        ...next,
        delivery: { mode: 'webhook', url: next.delivery.url },
      });
    }
    await expect(
      s.runtime.call('operator', 'events/subscribe', {
        ...args,
        delivery: { ...args.delivery, url: 'https://callback.example.test/full' },
      }),
    ).rejects.toThrow('storage is full');
    s.advance(9 * 86_400_000);
    await expect(s.runtime.call('operator', 'events/subscribe', args)).resolves.toHaveProperty(
      'id',
    );
  });
});

describePosix('DM Events subscriptions and durable delivery', () => {
  it('verifies signed callbacks, persists subscription/queue across restart, deduplicates messages', async () => {
    const s = setup();
    const first = await s.runtime.call('operator', 'events/subscribe', args);
    expect(await s.runtime.call('operator', 'events/subscribe', args)).toEqual(first);
    expect(s.post).toHaveBeenCalledTimes(1);
    expect(await s.runtime.observe(message)).toBe(true);
    expect(await s.runtime.observe(message)).toBe(false);
    s.runtime.close();
    const restarted = new DmEventRuntime(s.options);
    runtimes.push(restarted);
    await restarted.deliver();
    expect(restarted.status().delivery).toMatchObject([{ state: 'delivered', attempts: 1 }]);
    expect(JSON.parse(s.post.mock.calls[1]![1]).eventId).toBe(`discord_dm_${message.id}`);
  });
  it('rejects owners, invalid names/filters/secrets/cursors and competing recipients', async () => {
    const s = setup();
    await expect(s.runtime.call('stranger', 'events/list', {})).rejects.toMatchObject({
      code: -32001,
    });
    for (const changed of [
      { name: 'foo' },
      { arguments: { author_id: bot } },
      { arguments: { author_id: author, channel_id: channel } },
      { cursor: 'past' },
      { delivery: { ...args.delivery, secret: 'whsec_bad' } },
    ])
      await expect(
        s.runtime.call('operator', 'events/subscribe', { ...args, ...changed }),
      ).rejects.toBeDefined();
    await s.runtime.call('operator', 'events/subscribe', args);
    await expect(
      s.runtime.call('operator', 'events/subscribe', {
        ...args,
        delivery: { ...args.delivery, url: 'https://other.example.test' },
      }),
    ).rejects.toMatchObject({ code: -32001 });
  });
  it('bounds retries, retains event ID and handles 410/413 and terminal 4xx', async () => {
    const s = setup();
    await s.runtime.call('operator', 'events/subscribe', args);
    await s.runtime.observe(message);
    s.status(503);
    for (let i = 0; i < 6; i++) {
      await s.runtime.deliver();
      s.advance(300_000);
    }
    expect(s.runtime.status().delivery).toMatchObject([{ state: 'failed', attempts: 6 }]);
    expect(new Set(s.post.mock.calls.slice(1).map((c) => JSON.parse(c[1]).eventId)).size).toBe(1);
    for (const status of [410, 413, 403]) {
      const t = setup();
      await t.runtime.call('operator', 'events/subscribe', args);
      await t.runtime.observe(message);
      t.status(status);
      await t.runtime.deliver();
      t.advance(300_000);
      await t.runtime.deliver();
      expect(t.runtime.status().delivery).toMatchObject([{ state: 'failed', attempts: 1 }]);
    }
  });
  it('refreshes expiration, grants finite ttl for null, expires and idempotently unsubscribes', async () => {
    const s = setup();
    const first = await s.runtime.call('operator', 'events/subscribe', { ...args, ttlMs: 1000 });
    s.advance(500);
    const refreshed = await s.runtime.call('operator', 'events/subscribe', {
      ...args,
      ttlMs: 2000,
    });
    expect(refreshed.id).toBe(first.id);
    expect(Date.parse(refreshed.refreshBefore as string)).toBe(s.options.now() + 2000);
    await s.runtime.observe(message);
    s.advance(2001);
    await s.runtime.deliver();
    expect(s.runtime.status().delivery).toMatchObject([{ state: 'cancelled' }]);
    const finite = await s.runtime.call('operator', 'events/subscribe', { ...args, ttlMs: null });
    expect(finite.refreshBefore).toBeTypeOf('string');
    const stop = { ...args, delivery: { mode: 'webhook', url: args.delivery.url } };
    await s.runtime.call('operator', 'events/unsubscribe', stop);
    await s.runtime.call('operator', 'events/unsubscribe', stop);
    expect(await s.runtime.observe({ ...message, id: '111122223333444486' })).toBe(false);
  });
  it('ignores other users, bots, guild/group DMs, attachments/voice and empty text', async () => {
    const s = setup();
    await s.runtime.call('operator', 'events/subscribe', args);
    for (const changed of [
      { author: { id: bot, bot: true } },
      { author: { id: author, bot: true } },
      { author: { id: '111111111111111111' } },
      { channel_type: 3 },
      { channel_type: 0 },
      { guild_id: '111111111111111111' },
      { attachments: [{}] },
      { type: 20 },
      { content: '' },
    ])
      expect(await s.runtime.observe({ ...message, ...changed })).toBe(false);
    expect(s.runtime.status().delivery).toHaveLength(0);
  });
  it('does not accept application data until callback challenge succeeds', async () => {
    const s = setup();
    s.post.mockImplementationOnce(async () => ({ status: 200, body: '{"challenge":"wrong"}' }));
    await expect(s.runtime.call('operator', 'events/subscribe', args)).rejects.toMatchObject({
      code: -32015,
      data: { reason: 'challenge_failed' },
    });
    expect(await s.runtime.observe(message)).toBe(false);
  });
  it('signs with both keys during rotation then drops the old key', async () => {
    const s = setup();
    await s.runtime.call('operator', 'events/subscribe', args);
    const next = `whsec_${Buffer.alloc(32, 8).toString('base64')}`;
    s.post.mockImplementation(async (_url, body, headers) => {
      const data = JSON.parse(body);
      new Webhook(next).verify(body, headers);
      return { status: 200, body: JSON.stringify({ challenge: data.challenge }) };
    });
    await s.runtime.call('operator', 'events/subscribe', {
      ...args,
      delivery: { ...args.delivery, secret: next },
    });
    await s.runtime.observe(message);
    await s.runtime.deliver();
    expect(s.post.mock.calls.at(-1)![2]['webhook-signature']!.split(' ')).toHaveLength(2);
  });
});
describePosix('reply safety distinct from delivery deduplication', () => {
  it('binds channel to delivered event and prevents duplicate/different replies', async () => {
    const s = setup();
    await s.runtime.call('operator', 'events/subscribe', args);
    await s.runtime.observe(message);
    const reply = { event_id: `discord_dm_${message.id}`, content: 'Hi' };
    await expect(s.runtime.call('operator', 'dm/reply', reply)).rejects.toBeDefined();
    await s.runtime.deliver();
    expect(await s.runtime.call('operator', 'dm/reply', reply)).toMatchObject({
      status: 'sent',
      channel_id: channel,
    });
    expect(await s.runtime.call('operator', 'dm/reply', reply)).toMatchObject({ status: 'sent' });
    expect(s.rest.post).toHaveBeenCalledTimes(1);
    expect(s.rest.post.mock.calls[0]).toMatchObject([
      `/channels/${channel}/messages`,
      {
        body: {
          nonce: message.id,
          enforce_nonce: true,
          allowed_mentions: { parse: [] },
          message_reference: { message_id: message.id },
        },
      },
    ]);
    await expect(
      s.runtime.call('operator', 'dm/reply', { ...reply, content: 'Different' }),
    ).rejects.toBeDefined();
    await expect(
      s.runtime.call('operator', 'dm/reply', { ...reply, event_id: 'arbitrary' }),
    ).rejects.toBeDefined();
  });
  it('reconciles an uncertain send across restart without resending', async () => {
    const s = setup();
    await s.runtime.call('operator', 'events/subscribe', args);
    await s.runtime.observe(message);
    await s.runtime.deliver();
    s.rest.post.mockRejectedValueOnce(new Error('Connection lost'));
    const reply = { event_id: `discord_dm_${message.id}`, content: 'Hi' };
    expect(await s.runtime.call('operator', 'dm/reply', reply)).toMatchObject({
      status: 'needs_review',
    });
    s.runtime.close();
    const restarted = new DmEventRuntime(s.options);
    runtimes.push(restarted);
    expect(await restarted.call('operator', 'dm/reply', reply)).toMatchObject({
      status: 'needs_review',
    });
    expect(s.rest.post).toHaveBeenCalledTimes(1);
    s.rest.get.mockImplementation(async (path) =>
      path.endsWith(channel)
        ? { id: channel, type: 1, recipients: [{ id: author }] }
        : ([
            {
              id: '111122223333444485',
              author: { id: bot },
              content: 'Hi',
              message_reference: { message_id: message.id },
            },
          ] as never),
    );
    expect(await restarted.call('operator', 'dm/reply', reply)).toMatchObject({
      status: 'sent',
      reconciled: true,
    });
    expect(s.rest.post).toHaveBeenCalledTimes(1);
  });
  it('rejects revoked DM recipient and reports definite rejection without resend', async () => {
    const s = setup();
    await s.runtime.call('operator', 'events/subscribe', args);
    await s.runtime.observe(message);
    await s.runtime.deliver();
    s.rest.get.mockResolvedValueOnce({ id: channel, type: 1, recipients: [{ id: bot }] });
    await expect(
      s.runtime.call('operator', 'dm/reply', {
        event_id: `discord_dm_${message.id}`,
        content: 'Hi',
      }),
    ).rejects.toBeDefined();
    expect(s.rest.post).not.toHaveBeenCalled();
    s.rest.post.mockRejectedValueOnce({ status: 403 });
    expect(
      await s.runtime.call('operator', 'dm/reply', {
        event_id: `discord_dm_${message.id}`,
        content: 'Hi',
      }),
    ).toMatchObject({ status: 'failed' });
  });
});
describe('callback boundary', () => {
  it('blocks nonpublic IPv4/IPv6, mapped addresses, credentials, HTTP and redirects by design', () => {
    for (const address of [
      '127.0.0.1',
      '10.1.1.1',
      '172.16.0.1',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '::1',
      '::',
      'fc00::1',
      'fe80::1',
      '::ffff:127.0.0.1',
      '224.0.0.1',
      '192.0.2.1',
      '2001:db8::1',
    ])
      expect(publicAddress(address), address).toBe(false);
    expect(publicAddress('1.1.1.1')).toBe(true);
    expect(publicAddress('2606:4700:4700::1111')).toBe(true);
    for (const url of [
      'http://example.com',
      'https://a:b@example.com',
      'https://example.com:123',
      'https://example.com/#secret',
    ])
      expect(() => callbackUrl(url)).toThrow();
    expect(() => validateSecret(secret)).not.toThrow();
    expect(() => validateSecret('whsec_bad')).toThrow();
  });
  it('fails wrong challenge, non2xx and malformed callback responses', async () => {
    for (const response of [
      { status: 200, body: '{}' },
      { status: 302, body: '{}' },
      { status: 200, body: 'oops' },
    ])
      await expect(
        verifyCallback(async () => response, { id: 'sub', url: args.delivery.url, secret }),
      ).rejects.toBeDefined();
  });
});

describePosix('Events failure recovery', () => {
  it('rolls back the subscription if its scope cannot be persisted and allows a clean retry', async () => {
    const s = setup();
    const prepare = s.runtime.db.prepare.bind(s.runtime.db);
    const intercept = vi.spyOn(s.runtime.db, 'prepare').mockImplementation((sql) => {
      if (sql.startsWith('INSERT OR REPLACE INTO subscription_scopes'))
        throw new Error('disk failure');
      return prepare(sql);
    });
    await expect(s.runtime.call('operator', 'events/subscribe', args)).rejects.toThrow(
      'disk failure',
    );
    intercept.mockRestore();
    expect(s.runtime.status().subscriptions).toEqual([]);
    await s.runtime.call('operator', 'events/subscribe', args);
    expect(s.runtime.status().subscriptions).toMatchObject([{ state: 'active' }]);
    await expect(s.runtime.call('operator', 'unknown/method', {})).rejects.toMatchObject({
      code: -32601,
    });
    await expect(
      s.runtime.call('operator', 'events/unsubscribe', { name: 'unknown' }),
    ).rejects.toMatchObject({ code: -32602 });
  });

  it('keeps an incomplete Discord send response uncertain and never sends it again', async () => {
    const s = setup();
    await s.runtime.call('operator', 'events/subscribe', args);
    await s.runtime.observe(message);
    await s.runtime.deliver();
    s.rest.post.mockResolvedValueOnce({ id: '', channel_id: channel });
    const reply = { event_id: `discord_dm_${message.id}`, content: 'Hi' };
    expect(await s.runtime.call('operator', 'dm/reply', reply)).toMatchObject({
      status: 'needs_review',
    });
    expect(await s.runtime.call('operator', 'dm/reply', reply)).toMatchObject({
      status: 'needs_review',
    });
    expect(s.rest.post).toHaveBeenCalledTimes(1);
  });
});
