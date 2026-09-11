import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGatewayClient } from './client.js';
import { SubscriptionRegistry } from './subscription_registry.js';

const discord = vi.hoisted(() => ({ Client: vi.fn() }));
vi.mock('discord.js', () => ({
  Client: discord.Client,
  GatewayIntentBits: { Guilds: 1, GuildVoiceStates: 128, GuildPresences: 256 },
}));

interface FakeClient extends EventEmitter {
  login: (token: string) => Promise<void>;
  destroy: () => Promise<void>;
  rest: { get: (path: string) => Promise<unknown> };
}

function makeFakeClient(): FakeClient {
  const c = new EventEmitter() as FakeClient;
  c.login = vi.fn().mockResolvedValue(undefined);
  c.destroy = vi.fn().mockResolvedValue(undefined);
  c.rest = { get: vi.fn().mockResolvedValue({ audit_log_entries: [] }) };
  return c;
}

describe('createGatewayClient', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('configures the default Discord client and polls subscribed audit logs', async () => {
    const fakeClient = makeFakeClient();
    discord.Client.mockImplementation(function MockDiscordClient() {
      return fakeClient;
    });
    const registry = new SubscriptionRegistry();
    registry.subscribe('discord://guild/123/audit-log/recent');
    const notify = vi.fn();
    vi.mocked(fakeClient.rest.get)
      .mockResolvedValueOnce({ audit_log_entries: [{ id: 'first' }] })
      .mockResolvedValueOnce({ audit_log_entries: [{ id: 'second' }] });
    const gateway = createGatewayClient({ token: 'fake-token', registry, notifyResource: notify });

    await gateway.start();
    expect(discord.Client).toHaveBeenCalledWith({ intents: [1, 128, 256] });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fakeClient.rest.get).toHaveBeenCalledWith('/guilds/123/audit-logs?limit=1');
    expect(notify).toHaveBeenCalledWith('discord://guild/123/audit-log/recent');
    await gateway.stop();
    await gateway.stop();
    expect(fakeClient.destroy).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves the login error when cleanup also fails', async () => {
    const fakeClient = makeFakeClient();
    const loginError = new Error('Login failed');
    vi.mocked(fakeClient.login).mockRejectedValue(loginError);
    vi.mocked(fakeClient.destroy).mockRejectedValue(new Error('Cleanup failed'));
    const gateway = createGatewayClient({
      token: 'fake-token',
      registry: new SubscriptionRegistry(),
      notifyResource: vi.fn(),
      clientFactory: () => fakeClient,
    });

    await expect(gateway.start()).rejects.toBe(loginError);
    await gateway.stop();
    expect(fakeClient.eventNames()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('returns { start, stop } object', () => {
    const registry = new SubscriptionRegistry();
    const gateway = createGatewayClient({
      token: 'fake-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      registry,
      notifyResource: vi.fn(),
      clientFactory: () => makeFakeClient(),
    });
    expect(gateway).toMatchObject({ start: expect.any(Function), stop: expect.any(Function) });
  });

  it('start() instantiates client + login; stop() destroys', async () => {
    const registry = new SubscriptionRegistry();
    const fakeClient = makeFakeClient();
    const factory = vi.fn().mockReturnValue(fakeClient);
    const gateway = createGatewayClient({
      token: 'fake-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      registry,
      notifyResource: vi.fn(),
      clientFactory: factory,
    });

    await gateway.start();
    expect(factory).toHaveBeenCalledTimes(1);
    expect(fakeClient.login).toHaveBeenCalledWith('fake-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaa');

    await gateway.stop();
    expect(fakeClient.destroy).toHaveBeenCalled();
  });

  it('forwards guildUpdate events to notifyResource for subscribed URIs', async () => {
    const registry = new SubscriptionRegistry();
    registry.subscribe('discord://guild/123/info');
    const notify = vi.fn();
    const fakeClient = makeFakeClient();

    const gateway = createGatewayClient({
      token: 'fake-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      registry,
      notifyResource: notify,
      clientFactory: () => fakeClient,
    });
    await gateway.start();
    fakeClient.emit('guildUpdate', null, { id: '123' });
    expect(notify).toHaveBeenCalledWith('discord://guild/123/info');
    await gateway.stop();
  });

  it('forwards voiceStateUpdate events', async () => {
    const registry = new SubscriptionRegistry();
    registry.subscribe('discord://voice/g_456/state');
    const notify = vi.fn();
    const fakeClient = makeFakeClient();

    const gateway = createGatewayClient({
      token: 'fake-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      registry,
      notifyResource: notify,
      clientFactory: () => fakeClient,
    });
    await gateway.start();
    fakeClient.emit('voiceStateUpdate', null, { guild: { id: 'g_456' } });
    expect(notify).toHaveBeenCalledWith('discord://voice/g_456/state');
    await gateway.stop();
  });

  it('unwinds listeners, poll interval and client when login() rejects', async () => {
    const registry = new SubscriptionRegistry();
    registry.subscribe('discord://guild/123/audit-log/recent');
    const fakeClient = makeFakeClient();
    fakeClient.login = vi.fn().mockRejectedValue(new Error('DisallowedIntents'));

    const gateway = createGatewayClient({
      token: 'fake-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      registry,
      notifyResource: vi.fn(),
      clientFactory: () => fakeClient,
    });

    await expect(gateway.start()).rejects.toThrow('DisallowedIntents');
    expect(fakeClient.destroy).toHaveBeenCalled();

    // The 60s audit-log poller must be gone - no REST traffic after the failure.
    await vi.advanceTimersByTimeAsync(180_000);
    expect(fakeClient.rest.get).not.toHaveBeenCalled();
    expect(fakeClient.listenerCount('guildUpdate')).toBe(0);
  });
});
