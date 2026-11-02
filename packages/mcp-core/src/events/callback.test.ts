import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ lookup: vi.fn(), request: vi.fn() }));
vi.mock('node:dns/promises', () => ({ lookup: mocks.lookup }));
vi.mock('node:https', () => ({ request: mocks.request }));

import { callbackUrl, publicAddress, signedPost, webhookPost } from './callback.js';

beforeEach(() => {
  vi.resetAllMocks();
});
describe('HTTPS callback connections', () => {
  it('pins validated DNS results, preserves hostname, forbids pooling and does not follow redirects', async () => {
    mocks.lookup.mockResolvedValue([{ address: '1.1.1.1', family: 4 }]);
    let pinned = '';
    let options: Record<string, unknown> = {};
    mocks.request.mockImplementation((url, opts, receive) => {
      expect(url.hostname).toBe('receiver.example');
      options = opts;
      opts.lookup('receiver.example', {}, (_error: unknown, address: string) => {
        pinned = address;
      });
      const req = new EventEmitter() as EventEmitter & { end: () => void };
      req.end = () => {
        const response = new EventEmitter() as EventEmitter & { statusCode: number };
        response.statusCode = 302;
        receive(response);
        response.emit('data', Buffer.from('{}'));
        response.emit('end');
      };
      return req;
    });
    expect(await webhookPost('https://receiver.example/callback', '{}', {})).toEqual({
      status: 302,
      body: '{}',
    });
    expect(pinned).toBe('1.1.1.1');
    expect(options.agent).toBe(false);
    expect(options.family).toBe(4);
    expect(mocks.request).toHaveBeenCalledTimes(1);
  });
  it('validates DNS again for every attempt and blocks mixed or rebound DNS results', async () => {
    mocks.lookup
      .mockResolvedValueOnce([
        { address: '1.1.1.1', family: 4 },
        { address: '127.0.0.1', family: 4 },
      ])
      .mockResolvedValueOnce([{ address: '10.0.0.1', family: 4 }]);
    for (let i = 0; i < 2; i++)
      await expect(
        webhookPost('https://receiver.example/callback', '{}', {}),
      ).rejects.toMatchObject({ reason: 'non_public_address' });
    expect(mocks.lookup).toHaveBeenCalledTimes(2);
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it('bounds response size and sanitizes network failures', async () => {
    mocks.lookup.mockResolvedValue([{ address: '1.1.1.1', family: 4 }]);
    mocks.request.mockImplementation((_url, _opts, receive) => {
      const req = new EventEmitter() as EventEmitter & { end: () => void };
      req.end = () => {
        const res = new EventEmitter() as EventEmitter & { destroy: () => void };
        res.destroy = () => {};
        receive(res);
        res.emit('data', Buffer.alloc(16385));
      };
      return req;
    });
    await expect(webhookPost('https://receiver.example/callback', '{}', {})).rejects.toMatchObject({
      reason: 'response_too_large',
    });
  });
});

it('rejects invalid addresses and payloads before any network request', async () => {
  expect(publicAddress('not-an-address')).toBe(false);
  expect(() => callbackUrl('not-a-url')).toThrow('Callback endpoint rejected');
  const post = vi.fn();
  await expect(
    signedPost(
      post,
      { id: 'sub', url: 'https://receiver.example', secret: 'unused' },
      'event',
      'x'.repeat(262_145),
    ),
  ).rejects.toThrow('Event payload too large');
  expect(post).not.toHaveBeenCalled();
});

it('sanitizes DNS failures and rejects an empty answer without connecting', async () => {
  mocks.lookup
    .mockRejectedValueOnce(new Error('private resolver diagnostic'))
    .mockResolvedValueOnce([]);
  await expect(webhookPost('https://receiver.example', '{}', {})).rejects.toMatchObject({
    reason: 'dns_failed',
  });
  await expect(webhookPost('https://receiver.example', '{}', {})).rejects.toMatchObject({
    reason: 'non_public_address',
  });
  expect(mocks.request).not.toHaveBeenCalled();
});

it('bounds DNS resolution time even if the resolver never returns', async () => {
  vi.useFakeTimers();
  try {
    mocks.lookup.mockReturnValue(new Promise(() => {}));
    const result = expect(webhookPost('https://receiver.example', '{}', {})).rejects.toMatchObject({
      reason: 'dns_timeout',
    });
    await vi.advanceTimersByTimeAsync(3000);
    await result;
    expect(mocks.request).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});

it.each(['request', 'response'])('sanitizes %s connection failures', async (failure) => {
  mocks.lookup.mockResolvedValue([{ address: '1.1.1.1', family: 4 }]);
  mocks.request.mockImplementation((_url, _options, receive) => {
    const req = new EventEmitter() as EventEmitter & { end: () => void };
    req.end = () => {
      if (failure === 'request') req.emit('error', new Error('private connection diagnostic'));
      else {
        const res = new EventEmitter();
        receive(res);
        res.emit('error', new Error('private response diagnostic'));
      }
    };
    return req;
  });
  await expect(webhookPost('https://receiver.example', '{}', {})).rejects.toMatchObject({
    reason: failure === 'request' ? 'timeout_or_connection_failed' : 'connection_failed',
  });
});
