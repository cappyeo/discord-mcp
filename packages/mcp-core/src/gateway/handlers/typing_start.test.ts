import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SubscriptionRegistry } from '../subscription_registry.js';
import { bindTypingStartHandler } from './typing_start.js';

describe('bindTypingStartHandler', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('notifies immediately then coalesces the rest of the window into 1 trailing notify', () => {
    const fakeClient = new EventEmitter();
    const registry = new SubscriptionRegistry();
    registry.subscribe('discord://channel/c1/typing');
    const notify = vi.fn();
    bindTypingStartHandler({ client: fakeClient as never, registry, notifyResource: notify });

    fakeClient.emit('typingStart', { channel: { id: 'c1' } });
    fakeClient.emit('typingStart', { channel: { id: 'c1' } });
    fakeClient.emit('typingStart', { channel: { id: 'c1' } });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith('discord://channel/c1/typing');
    vi.advanceTimersByTime(5000);
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it('skips unsubscribed channels', () => {
    const fakeClient = new EventEmitter();
    const registry = new SubscriptionRegistry();
    const notify = vi.fn();
    bindTypingStartHandler({ client: fakeClient as never, registry, notifyResource: notify });
    fakeClient.emit('typingStart', { channel: { id: 'c2' } });
    vi.advanceTimersByTime(5000);
    expect(notify).not.toHaveBeenCalled();
  });

  it('notifies every subscribed URI active within one window', () => {
    const fakeClient = new EventEmitter();
    const registry = new SubscriptionRegistry();
    registry.subscribe('discord://channel/c1/typing');
    registry.subscribe('discord://channel/c2/typing');
    const notify = vi.fn();
    bindTypingStartHandler({ client: fakeClient as never, registry, notifyResource: notify });

    fakeClient.emit('typingStart', { channel: { id: 'c1' } });
    fakeClient.emit('typingStart', { channel: { id: 'c2' } });
    fakeClient.emit('typingStart', { channel: { id: 'c1' } });
    vi.advanceTimersByTime(5000);

    expect(notify.mock.calls.map((c) => c[0])).toContain('discord://channel/c1/typing');
    expect(notify.mock.calls.map((c) => c[0])).toContain('discord://channel/c2/typing');
  });

  it('a noisy unsubscribed channel does not suppress a subscribed one', () => {
    const fakeClient = new EventEmitter();
    const registry = new SubscriptionRegistry();
    registry.subscribe('discord://channel/c1/typing');
    const notify = vi.fn();
    bindTypingStartHandler({ client: fakeClient as never, registry, notifyResource: notify });

    fakeClient.emit('typingStart', { channel: { id: 'c1' } });
    for (let i = 0; i < 20; i++) {
      vi.advanceTimersByTime(100);
      fakeClient.emit('typingStart', { channel: { id: 'noisy' } });
    }
    vi.advanceTimersByTime(5000);

    expect(notify.mock.calls.every((c) => c[0] === 'discord://channel/c1/typing')).toBe(true);
    expect(notify.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it('sustained sub-window events still produce bounded-rate notifications', () => {
    const fakeClient = new EventEmitter();
    const registry = new SubscriptionRegistry();
    registry.subscribe('discord://channel/c1/typing');
    const notify = vi.fn();
    bindTypingStartHandler({ client: fakeClient as never, registry, notifyResource: notify });

    // 20s of continuous typing, one event per second.
    for (let i = 0; i < 20; i++) {
      fakeClient.emit('typingStart', { channel: { id: 'c1' } });
      vi.advanceTimersByTime(1000);
    }

    // Leading fire + one per 5s window - never starved, never per-event.
    expect(notify.mock.calls.length).toBeGreaterThanOrEqual(4);
    expect(notify.mock.calls.length).toBeLessThanOrEqual(6);
  });

  it('teardown removes listener and cancels a pending notify', () => {
    const fakeClient = new EventEmitter();
    const registry = new SubscriptionRegistry();
    registry.subscribe('discord://channel/c1/typing');
    const notify = vi.fn();
    const teardown = bindTypingStartHandler({
      client: fakeClient as never,
      registry,
      notifyResource: notify,
    });
    teardown();
    fakeClient.emit('typingStart', { channel: { id: 'c1' } });
    vi.advanceTimersByTime(5000);
    expect(notify).not.toHaveBeenCalled();
  });

  it('teardown after a pending event fires no further notify', () => {
    const fakeClient = new EventEmitter();
    const registry = new SubscriptionRegistry();
    registry.subscribe('discord://channel/c1/typing');
    const notify = vi.fn();
    const teardown = bindTypingStartHandler({
      client: fakeClient as never,
      registry,
      notifyResource: notify,
    });
    fakeClient.emit('typingStart', { channel: { id: 'c1' } });
    fakeClient.emit('typingStart', { channel: { id: 'c1' } });
    notify.mockClear();
    teardown();
    vi.advanceTimersByTime(5000);
    expect(notify).not.toHaveBeenCalled();
  });
});
