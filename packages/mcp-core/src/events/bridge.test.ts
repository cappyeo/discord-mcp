import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { createEventBridge, eventBridgeFromConfig } from './bridge.js';

it('enforces catalog boundaries on context and reply calls before reaching the worker', async () => {
  const mentions = createEventBridge('/unreachable.sock', 'operator', 'mentions');
  const dm = createEventBridge('/unreachable.sock', 'operator', 'dm');
  for (const method of [
    'dm/context',
    'dm/reply',
    'message/context',
    'message/reply',
    'message/scope',
  ]) {
    await expect(
      mentions.call(method, { event_id: 'discord_dm_111122223333444481' }),
    ).rejects.toMatchObject({ code: -32001 });
  }
  await expect(
    dm.call('message/context', { event_id: 'discord_mention_111122223333444481' }),
  ).rejects.toMatchObject({ code: -32001 });
});

it.skipIf(process.platform === 'win32')(
  'provides event-specific plugin catalogs over one shared worker and rejects cross-catalog subscriptions',
  async () => {
    const directory = mkdtempSync(join(tmpdir(), 'event-catalog-'));
    const socket = join(directory, 'worker.sock');
    let requests = 0;
    const server = createServer(async (req, res) => {
      let body = '';
      for await (const chunk of req) body += chunk;
      const parsed = JSON.parse(body);
      requests++;
      expect(parsed.owner).toBe('operator');
      res.end(
        JSON.stringify({
          result: { events: [{ name: 'message.created' }, { name: 'message.mentioned' }] },
        }),
      );
    });
    await new Promise<void>((resolve) => server.listen(socket, resolve));
    try {
      const dm = createEventBridge(socket, 'operator', 'dm'),
        mention = createEventBridge(socket, 'operator', 'mentions'),
        all = createEventBridge(socket, 'operator');
      expect(await dm.call('events/list', {})).toEqual({ events: [{ name: 'message.created' }] });
      expect(await mention.call('events/list', {})).toEqual({
        events: [{ name: 'message.mentioned' }],
      });
      expect((await all.call('events/list', {})).events).toHaveLength(2);
      await expect(
        dm.call('events/subscribe', { name: 'message.mentioned' }),
      ).rejects.toMatchObject({
        code: -32001,
      });
      await expect(
        mention.call('events/subscribe', { name: 'message.created' }),
      ).rejects.toMatchObject({ code: -32001 });
      expect(requests).toBe(3);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

it('requires a trusted owner and absolute socket together and leaves ordinary sessions unchanged', () => {
  const base = { DISCORD_TOKEN: 'Bot fake.test.token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' };
  expect(eventBridgeFromConfig(loadConfig(base))).toBeUndefined();
  for (const settings of [
    { MCP_EVENTS_OWNER: 'operator' },
    { MCP_EVENTS_SOCKET: '/private/worker.sock' },
    { MCP_EVENTS_OWNER: 'operator', MCP_EVENTS_SOCKET: 'relative.sock' },
  ])
    expect(() => eventBridgeFromConfig(loadConfig({ ...base, ...settings }))).toThrow(
      'required together',
    );
  expect(
    eventBridgeFromConfig(
      loadConfig({
        ...base,
        MCP_EVENTS_OWNER: 'operator',
        MCP_EVENTS_SOCKET: '/private/worker.sock',
        MCP_EVENTS_CATALOG: 'dm',
      }),
    ),
  ).toHaveProperty('call');
});

it.skipIf(process.platform === 'win32')(
  'preserves worker authorization errors and sanitizes malformed or disconnected responses',
  async () => {
    const directory = mkdtempSync(join(tmpdir(), 'event-errors-'));
    const socket = join(directory, 'worker.sock');
    let response = JSON.stringify({
      error: { code: -32001, message: 'Event access denied', data: { reason: 'request_rejected' } },
    });
    const server = createServer(async (req, res) => {
      for await (const _chunk of req) {
        /* drain request */
      }
      res.end(response);
    });
    await new Promise<void>((resolve) => server.listen(socket, resolve));
    const bridge = createEventBridge(socket, 'operator');
    try {
      await expect(bridge.call('dm/context', { event_id: 'private-event' })).rejects.toMatchObject({
        code: -32001,
        data: { reason: 'request_rejected' },
      });
      response = 'private malformed worker response';
      await expect(bridge.call('dm/context', {})).rejects.toMatchObject({ code: -32603 });
      response = 'x'.repeat(262_145);
      await expect(bridge.call('dm/context', {})).rejects.toMatchObject({ code: -32603 });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    try {
      await expect(bridge.call('dm/context', {})).rejects.toMatchObject({ code: -32603 });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
