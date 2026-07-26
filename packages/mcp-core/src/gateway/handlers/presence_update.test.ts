import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SubscriptionRegistry } from '../subscription_registry.js';
import { bindPresenceUpdateHandler } from './presence_update.js';

describe('bindPresenceUpdateHandler', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('notifies immediately then coalesces the rest of the window into 1 trailing notify', () => {
    const fakeClient = new EventEmitter();
    const registry = new SubscriptionRegistry();
    registry.subscribe('discord://guild/g1/members/online');
    const notify = vi.fn();
    bindPresenceUpdateHandler({ client: fakeClient as never, registry, notifyResource: notify });

    fakeClient.emit('presenceUpdate', null, { guild: { id: 'g1' } });
    fakeClient.emit('presenceUpdate', null, { guild: { id: 'g1' } });
    fakeClient.emit('presenceUpdate', null, { guild: { id: 'g1' } });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith('discord://guild/g1/members/online');
    vi.advanceTimersByTime(1000);
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it('skips unsubscribed URIs', () => {
    const fakeClient = new EventEmitter();
    const registry = new SubscriptionRegistry();
    const notify = vi.fn();
    bindPresenceUpdateHandler({ client: fakeClient as never, registry, notifyResource: notify });
    fakeClient.emit('presenceUpdate', null, { guild: { id: 'g_unknown' } });
    vi.advanceTimersByTime(1000);
    expect(notify).not.toHaveBeenCalled();
  });

  it('notifies every subscribed guild active within one window', () => {
    const fakeClient = new EventEmitter();
    const registry = new SubscriptionRegistry();
    registry.subscribe('discord://guild/g1/members/online');
    registry.subscribe('discord://guild/g2/members/online');
    const notify = vi.fn();
    bindPresenceUpdateHandler({ client: fakeClient as never, registry, notifyResource: notify });

    fakeClient.emit('presenceUpdate', null, { guild: { id: 'g1' } });
    fakeClient.emit('presenceUpdate', null, { guild: { id: 'g2' } });
    fakeClient.emit('presenceUpdate', null, { guild: { id: 'g1' } });
    vi.advanceTimersByTime(1000);

    expect(notify.mock.calls.map((c) => c[0])).toContain('discord://guild/g1/members/online');
    expect(notify.mock.calls.map((c) => c[0])).toContain('discord://guild/g2/members/online');
  });

  it('a noisy unsubscribed guild does not suppress a subscribed one', () => {
    const fakeClient = new EventEmitter();
    const registry = new SubscriptionRegistry();
    registry.subscribe('discord://guild/g1/members/online');
    const notify = vi.fn();
    bindPresenceUpdateHandler({ client: fakeClient as never, registry, notifyResource: notify });

    fakeClient.emit('presenceUpdate', null, { guild: { id: 'g1' } });
    for (let i = 0; i < 20; i++) {
      vi.advanceTimersByTime(100);
      fakeClient.emit('presenceUpdate', null, { guild: { id: 'g_noisy' } });
    }
    vi.advanceTimersByTime(1000);

    expect(notify.mock.calls.every((c) => c[0] === 'discord://guild/g1/members/online')).toBe(true);
    expect(notify.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it('sustained sub-window events still produce bounded-rate notifications', () => {
    const fakeClient = new EventEmitter();
    const registry = new SubscriptionRegistry();
    registry.subscribe('discord://guild/g1/members/online');
    const notify = vi.fn();
    bindPresenceUpdateHandler({ client: fakeClient as never, registry, notifyResource: notify });

    // 4s of continuous presence churn, one event every 200ms.
    for (let i = 0; i < 20; i++) {
      fakeClient.emit('presenceUpdate', null, { guild: { id: 'g1' } });
      vi.advanceTimersByTime(200);
    }

    // Leading fire + one per 1s window — never starved, never per-event.
    expect(notify.mock.calls.length).toBeGreaterThanOrEqual(4);
    expect(notify.mock.calls.length).toBeLessThanOrEqual(6);
  });

  it('teardown removes listener and cancels a pending notify', () => {
    const fakeClient = new EventEmitter();
    const registry = new SubscriptionRegistry();
    registry.subscribe('discord://guild/g1/members/online');
    const notify = vi.fn();
    const teardown = bindPresenceUpdateHandler({
      client: fakeClient as never,
      registry,
      notifyResource: notify,
    });
    teardown();
    fakeClient.emit('presenceUpdate', null, { guild: { id: 'g1' } });
    vi.advanceTimersByTime(1000);
    expect(notify).not.toHaveBeenCalled();
  });

  it('teardown after a pending event fires no further notify', () => {
    const fakeClient = new EventEmitter();
    const registry = new SubscriptionRegistry();
    registry.subscribe('discord://guild/g1/members/online');
    const notify = vi.fn();
    const teardown = bindPresenceUpdateHandler({
      client: fakeClient as never,
      registry,
      notifyResource: notify,
    });
    fakeClient.emit('presenceUpdate', null, { guild: { id: 'g1' } });
    fakeClient.emit('presenceUpdate', null, { guild: { id: 'g1' } });
    notify.mockClear();
    teardown();
    vi.advanceTimersByTime(1000);
    expect(notify).not.toHaveBeenCalled();
  });
});
