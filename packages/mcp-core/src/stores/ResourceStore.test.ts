import { describe, expect, it } from 'vitest';
import { ResourceStore } from './ResourceStore.js';

describe('ResourceStore', () => {
  it('list() returns 6 V2 resources (5 templates + 1 schema)', async () => {
    const store = new ResourceStore();
    const resources = await store.list();
    expect(resources.length).toBe(6);
  });

  it('list() includes the components-v2 schema URI', async () => {
    const store = new ResourceStore();
    const resources = await store.list();
    expect(resources.map((r) => r.uri)).toContain('discord://components-v2/schema');
  });

  it('list() includes the announcement template URI', async () => {
    const store = new ResourceStore();
    const resources = await store.list();
    expect(resources.map((r) => r.uri)).toContain('discord://components-v2/templates/announcement');
  });

  it('list() entries expose name + description + mimeType', async () => {
    const store = new ResourceStore();
    const resources = await store.list();
    for (const r of resources) {
      expect(r.uri).toBeTypeOf('string');
      expect(r.name).toBeTypeOf('string');
      expect(r.description).toBeTypeOf('string');
      expect(r.mimeType).toBe('application/json');
    }
  });

  it('read() returns content for a known template URI', async () => {
    const store = new ResourceStore();
    const content = await store.read('discord://components-v2/templates/announcement');
    expect(content).not.toBeNull();
    expect(content!.uri).toBe('discord://components-v2/templates/announcement');
    expect(content!.mimeType).toBe('application/json');
    const parsed = JSON.parse(content!.text);
    expect(parsed.name).toBe('announcement');
  });

  it('read() returns content for the schema URI', async () => {
    const store = new ResourceStore();
    const content = await store.read('discord://components-v2/schema');
    expect(content).not.toBeNull();
    expect(content!.mimeType).toBe('application/json');
    // Schema text is valid JSON.
    expect(() => JSON.parse(content!.text)).not.toThrow();
  });

  it('read() returns null for an unknown template name', async () => {
    const store = new ResourceStore();
    const content = await store.read('discord://components-v2/templates/does_not_exist');
    expect(content).toBeNull();
  });

  it('read() returns null for a malformed URI scheme', async () => {
    const store = new ResourceStore();
    const content = await store.read('not-a-discord-uri');
    expect(content).toBeNull();
  });

  it('read() returns null for an unrelated discord:// URI (no static match)', async () => {
    const store = new ResourceStore();
    const content = await store.read('discord://guild/123/info');
    expect(content).toBeNull();
  });

  it('multiple instances behave independently and idempotently', async () => {
    const a = new ResourceStore();
    const b = new ResourceStore();
    const [la, lb] = await Promise.all([a.list(), b.list()]);
    expect(la.length).toBe(lb.length);
    expect(la.map((r) => r.uri).sort()).toEqual(lb.map((r) => r.uri).sort());
  });

  it('lists and reads an allowlisted live guild snapshot with bounded caching', async () => {
    const guildId = '111122223333444455';
    const uri = `discord://guild/${guildId}/info`;
    let calls = 0;
    let version = 1;
    let now = 1_000;
    const authorized: string[] = [];
    const store = new ResourceStore({
      guildIds: [guildId],
      now: () => now,
      cacheTtlMs: 5_000,
      authorize: (target) => authorized.push(target),
      readGuildInfo: async (id) => ({ id, name: `Guild ${version++}` }),
    });

    expect((await store.list()).map((resource) => resource.uri)).toContain(uri);
    const first = await store.read(uri);
    const second = await store.read(uri);
    expect(first).not.toBeNull();
    expect(JSON.parse(first!.text).data.name).toBe('Guild 1');
    expect(second).toEqual(first);
    expect(calls).toBe(0);
    expect(authorized).toEqual([uri, uri]);

    // Count provider calls separately without changing the cache contract.
    const live = new ResourceStore({
      guildIds: [guildId],
      now: () => now,
      cacheTtlMs: 5_000,
      readGuildInfo: async (id) => {
        calls += 1;
        return { id, version: calls };
      },
    });
    await live.read(uri);
    await live.read(uri);
    expect(calls).toBe(1);
    now += 5_001;
    await live.read(uri);
    expect(calls).toBe(2);
    live.invalidate(uri);
    await live.read(uri);
    expect(calls).toBe(3);
  });

  it('does not expose dynamic guild URIs without a reader and returns null for them', async () => {
    const guildId = '111122223333444455';
    const store = new ResourceStore({ guildIds: [guildId] });
    expect((await store.list()).map((resource) => resource.uri)).not.toContain(
      `discord://guild/${guildId}/info`,
    );
    expect(await store.read(`discord://guild/${guildId}/info`)).toBeNull();
  });

  it('refuses an unconfigured guild URI before invoking the reader', async () => {
    let calls = 0;
    const store = new ResourceStore({
      guildIds: ['111122223333444455'],
      readGuildInfo: async () => {
        calls += 1;
        return {};
      },
    });
    expect(await store.read('discord://guild/999988887777666655/info')).toBeNull();
    expect(calls).toBe(0);
  });
});
