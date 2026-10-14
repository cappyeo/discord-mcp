import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import channelsModify from './modify.js';
import '../../container.js';

const API = 'https://discord.com/api/v10';
const CHANNEL = '111122223333444401';
const PARENT = '111122223333444402';
const OLD_PARENT = '111122223333444403';
const GUILD = '999000999000999000';
const MEMBER = '111122223333444404';
const overwrites = [
  { id: GUILD, type: 0, allow: '0', deny: '1024' },
  { id: MEMBER, type: 1, allow: '9007199254740993', deny: '0' },
];

describe('channels_modify permission sync', () => {
  let tool: InstanceType<typeof channelsModify>;
  let channel: Record<string, unknown>;
  let parent: Record<string, unknown>;
  let requests: string[];
  let patched: Record<string, unknown> | undefined;
  let readbackFails: boolean;

  beforeEach(() => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token');
    tool = new channelsModify(
      { name: 'channels_modify', path: 'inline', root: 'inline', store: null as never },
      { name: 'channels_modify', enabled: true },
    );
    channel = {
      id: CHANNEL,
      guild_id: GUILD,
      name: 'private',
      type: 0,
      parent_id: PARENT,
      permission_overwrites: [],
    };
    parent = { id: PARENT, guild_id: GUILD, type: 4, permission_overwrites: overwrites };
    requests = [];
    patched = undefined;
    readbackFails = false;
    server.use(
      http.get(`${API}/channels/${CHANNEL}`, () => {
        requests.push('GET channel');
        if (patched && readbackFails)
          return HttpResponse.json({ message: 'Missing Access', code: 50001 }, { status: 403 });
        return HttpResponse.json(channel);
      }),
      http.get(`${API}/channels/${PARENT}`, () => {
        requests.push('GET parent');
        return HttpResponse.json(parent);
      }),
      http.patch(`${API}/channels/${CHANNEL}`, async ({ request }) => {
        requests.push('PATCH');
        patched = (await request.json()) as Record<string, unknown>;
        channel = { ...channel, ...patched };
        return HttpResponse.json(channel);
      }),
    );
  });

  async function run(extra: Record<string, unknown> = {}) {
    const args = z.object(tool.inputSchema).parse({
      channel_id: CHANNEL,
      parent_id: PARENT,
      lock_permissions: true,
      ...extra,
    });
    return (await tool.run(args, { signal: new AbortController().signal })) as {
      isError: boolean;
      structuredContent: Record<string, unknown>;
    };
  }

  it('syncs the current parent in one PATCH, preserving exact role/member bitfields', async () => {
    const result = await run({ name: 'private-renamed' });
    expect(requests).toEqual(['GET channel', 'GET parent', 'PATCH', 'GET channel', 'GET parent']);
    expect(patched).toEqual({
      name: 'private-renamed',
      parent_id: PARENT,
      permission_overwrites: overwrites,
    });
    expect(patched).not.toHaveProperty('lock_permissions');
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toMatchObject({
      parent_id: PARENT,
      permission_overwrites: overwrites,
      permissions_verified: true,
    });
  });

  it('moves and syncs the new category in the same write', async () => {
    channel.parent_id = OLD_PARENT;
    expect((await run()).structuredContent.permissions_verified).toBe(true);
    expect(requests.filter((request) => request === 'PATCH')).toHaveLength(1);
    expect(channel.parent_id).toBe(PARENT);
  });

  it('copies a known empty overwrite set', async () => {
    parent.permission_overwrites = [];
    const result = await run();
    expect(patched?.permission_overwrites).toEqual([]);
    expect(result.structuredContent.permissions_verified).toBe(true);
  });

  it.each([
    ['omitted parent', { parent_id: undefined }],
    ['null parent', { parent_id: null }],
    ['explicit overwrites', { permission_overwrites: [] }],
  ])('rejects %s before any request', async (_label, args) => {
    await expect(run(args)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(requests).toEqual([]);
  });

  it.each([
    ['non-category', { type: 0 }],
    ['other guild', { guild_id: '999000999000999001' }],
    ['wrong ID', { id: OLD_PARENT }],
    ['missing overwrite set', { permission_overwrites: undefined }],
    ['malformed bitfield', { permission_overwrites: [{ ...overwrites[0], allow: 'invalid' }] }],
    ['obfuscated category', { flags: 1 << 17 }],
  ])('refuses an unreadable %s without writing', async (_label, state) => {
    parent = { ...parent, ...state };
    await expect(run()).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(patched).toBeUndefined();
  });

  it('refuses thread targets without writing', async () => {
    channel.type = 11;
    await expect(run()).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(patched).toBeUndefined();
  });

  it('accepts overwrite reordering on readback', async () => {
    server.use(
      http.patch(`${API}/channels/${CHANNEL}`, async ({ request }) => {
        patched = (await request.json()) as Record<string, unknown>;
        channel = { ...channel, ...patched, permission_overwrites: [...overwrites].reverse() };
        return HttpResponse.json(channel);
      }),
    );
    expect((await run()).structuredContent.permissions_verified).toBe(true);
  });

  it('reports a successful mutation with unavailable verification without retrying', async () => {
    readbackFails = true;
    const result = await run();
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      code: 'PERMISSION_VERIFICATION_FAILED',
      patch_succeeded: true,
      retriable: false,
    });
    expect(requests.filter((request) => request === 'PATCH')).toHaveLength(1);
  });

  it.each([
    ['malformed overwrites', { permission_overwrites: [{ ...overwrites[0], allow: 'invalid' }] }],
    ['wrong parent', { parent_id: OLD_PARENT }],
  ])('reports %s on readback without another write', async (_label, readback) => {
    server.use(
      http.patch(`${API}/channels/${CHANNEL}`, async ({ request }) => {
        patched = (await request.json()) as Record<string, unknown>;
        channel = { ...channel, ...patched, ...readback };
        return HttpResponse.json(channel);
      }),
    );
    const result = await run();
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      code: 'PERMISSION_VERIFICATION_FAILED',
      patch_succeeded: true,
      retriable: false,
    });
    expect(patched).toEqual({ parent_id: PARENT, permission_overwrites: overwrites });
  });

  it('detects category changes between copy and readback', async () => {
    server.use(
      http.patch(`${API}/channels/${CHANNEL}`, async ({ request }) => {
        patched = (await request.json()) as Record<string, unknown>;
        channel = { ...channel, ...patched };
        parent.permission_overwrites = [];
        return HttpResponse.json(channel);
      }),
    );
    const result = await run();
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      code: 'PERMISSION_VERIFICATION_FAILED',
      patch_succeeded: true,
      retriable: false,
    });
  });

  it('leaves ordinary modifications unchanged when lock_permissions is false', async () => {
    const result = await run({ lock_permissions: false });
    expect(requests).toEqual(['PATCH']);
    expect(patched).toEqual({ parent_id: PARENT });
    expect(result.structuredContent).not.toHaveProperty('permissions_verified');
  });
});
