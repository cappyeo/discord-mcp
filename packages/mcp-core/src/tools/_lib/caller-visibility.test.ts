import { describe, expect, it } from 'vitest';
import {
  filterCallerVisibleChannels,
  filterCallerVisibleThreads,
  type VisibilityChannel,
} from './caller-visibility.js';

const GUILD = '111122223333444455';
const CALLER = '111122223333444466';
const VIEWER = '111122223333444477';
const BLOCKED = '111122223333444488';
const PARENT = '111122223333444499';

/** Minimal REST stand-in: routes matched by path suffix. */
function restFor(routes: Record<string, unknown>, calls: string[] = []) {
  return {
    get: async (path: string) => {
      calls.push(path);
      for (const [suffix, value] of Object.entries(routes)) {
        if (path.endsWith(suffix)) return value;
      }
      throw new Error(`unexpected route ${path}`);
    },
  } as never;
}

const roles = [{ id: GUILD, name: '@everyone', position: 0, permissions: '1024', managed: false }];

describe('filterCallerVisibleChannels', () => {
  it('returns the full listing when no end user is acting', async () => {
    const channels = [{ id: BLOCKED, type: 0, parent_id: null }];
    await expect(
      filterCallerVisibleChannels(restFor({}), GUILD, channels, undefined),
    ).resolves.toEqual(channels);
  });

  it('drops a channel whose overwrite denies the caller VIEW_CHANNEL', async () => {
    const rest = restFor({
      [`/guilds/${GUILD}`]: { id: GUILD, owner_id: '111122223333444400' },
      [`/guilds/${GUILD}/members/${CALLER}`]: { roles: [] },
      [`/guilds/${GUILD}/roles`]: roles,
    });
    const channels: VisibilityChannel[] = [
      { id: BLOCKED, type: 0, parent_id: null, permission_overwrites: [] },
      {
        id: PARENT,
        type: 0,
        parent_id: null,
        permission_overwrites: [
          { id: GUILD, type: 0, allow: '0', deny: '1024' },
          { id: VIEWER, type: 0, allow: '0', deny: '1024' },
        ],
      },
    ];
    const visible = await filterCallerVisibleChannels(rest, GUILD, channels, CALLER);
    expect(visible.map((channel) => channel.id)).toEqual([BLOCKED]);
  });

  it('applies category overwrites before the channel overwrite', async () => {
    const rest = restFor({
      [`/guilds/${GUILD}`]: { id: GUILD, owner_id: '111122223333444400' },
      [`/guilds/${GUILD}/members/${CALLER}`]: { roles: [] },
      [`/guilds/${GUILD}/roles`]: roles,
    });
    const channels: VisibilityChannel[] = [
      {
        id: '111122223333444401',
        type: 4,
        parent_id: null,
        permission_overwrites: [
          { id: GUILD, type: 0, allow: '0', deny: '1024' },
          { id: CALLER, type: 1, allow: '1024', deny: '0' },
        ],
      },
      { id: PARENT, type: 0, parent_id: '111122223333444401', permission_overwrites: [] },
    ];
    const visible = await filterCallerVisibleChannels(rest, GUILD, channels, CALLER);
    // Category grants VIEW_CHANNEL to the caller; the child re-runs the base
    // bits, then the category layer, so the member allow still wins.
    expect(visible.map((channel) => channel.id)).toContain(PARENT);
  });

  it('hides everything when the caller is not a member', async () => {
    const rest = restFor({
      [`/guilds/${GUILD}`]: { id: GUILD, owner_id: '111122223333444400' },
      [`/guilds/${GUILD}/members/${CALLER}`]: { message: 'Unknown Member' },
      [`/guilds/${GUILD}/roles`]: roles,
    });
    const channels: VisibilityChannel[] = [
      { id: BLOCKED, type: 0, parent_id: null, permission_overwrites: [] },
    ];
    await expect(filterCallerVisibleChannels(rest, GUILD, channels, CALLER)).resolves.toEqual([]);
  });
});

describe('filterCallerVisibleThreads', () => {
  it('hides a thread whose parent the caller cannot view', async () => {
    const rest = restFor({
      [`/guilds/${GUILD}`]: { id: GUILD, owner_id: '111122223333444400' },
      [`/guilds/${GUILD}/members/${CALLER}`]: { roles: [] },
      [`/guilds/${GUILD}/roles`]: roles,
      [`/channels/${PARENT}`]: {
        id: PARENT,
        type: 0,
        parent_id: null,
        guild_id: GUILD,
        permission_overwrites: [{ id: GUILD, type: 0, allow: '0', deny: '1024' }],
      },
    });
    const visible = await filterCallerVisibleThreads(
      rest,
      [{ id: '111122223333444477', type: 11, parent_id: PARENT }],
      CALLER,
    );
    expect(visible).toEqual([]);
  });

  it('keeps a thread whose parent is viewable', async () => {
    const rest = restFor({
      [`/guilds/${GUILD}`]: { id: GUILD, owner_id: '111122223333444400' },
      [`/guilds/${GUILD}/members/${CALLER}`]: { roles: [] },
      [`/guilds/${GUILD}/roles`]: roles,
      [`/channels/${PARENT}`]: {
        id: PARENT,
        type: 0,
        parent_id: null,
        guild_id: GUILD,
        permission_overwrites: [],
      },
    });
    const threads = [{ id: '111122223333444477', type: 11, parent_id: PARENT }];
    await expect(filterCallerVisibleThreads(rest, threads, CALLER)).resolves.toEqual(threads);
  });

  it('hides private threads without MANAGE_THREADS', async () => {
    const rest = restFor({
      [`/guilds/${GUILD}`]: { id: GUILD, owner_id: '111122223333444400' },
      [`/guilds/${GUILD}/members/${CALLER}`]: { roles: [] },
      [`/guilds/${GUILD}/roles`]: roles,
      [`/channels/${PARENT}`]: {
        id: PARENT,
        type: 0,
        parent_id: null,
        guild_id: GUILD,
        permission_overwrites: [],
      },
    });
    const visible = await filterCallerVisibleThreads(
      rest,
      [{ id: '111122223333444477', type: 12, parent_id: PARENT }],
      CALLER,
    );
    expect(visible).toEqual([]);
  });
});
