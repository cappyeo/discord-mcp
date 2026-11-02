import { describe, expect, it } from 'vitest';
import { archivePageContract } from './archive-contract.js';
import { validatePage } from './page.js';

const parent = '111122223333444481';
const guild = '111122223333444482';
const row = (id: string, timestamp = '2026-01-01T00:00:00.123456Z') => ({
  id,
  parent_id: parent,
  guild_id: guild,
  thread_metadata: { archive_timestamp: timestamp },
});
const first = '111122223333444483';
const second = '111122223333444484';

describe('provider archive continuation evidence', () => {
  it('rejects wrong parent or guild rather than exposing a continuation for another scope', () => {
    expect(() =>
      archivePageContract(
        { threads: [{ ...row(first), parent_id: guild }], has_more: false },
        parent,
        10,
        undefined,
        false,
      ),
    ).toThrow('scope mismatch');
    expect(() =>
      archivePageContract(
        { threads: [row(first)], has_more: false },
        parent,
        10,
        undefined,
        false,
        [parent],
      ),
    ).toThrow('scope mismatch');
    expect(
      archivePageContract(
        { threads: [row(first)], has_more: false },
        parent,
        10,
        undefined,
        false,
        [guild],
      ),
    ).toMatchObject({ complete: true, has_more: false });
  });

  it('rejects malformed or empty continued pages before a checkpoint can advance', () => {
    expect(() =>
      archivePageContract(
        { threads: null, has_more: false } as never,
        parent,
        10,
        undefined,
        false,
      ),
    ).toThrow('Invalid Discord');
    expect(() =>
      archivePageContract({ threads: [], has_more: true }, parent, 10, undefined, false),
    ).toThrow('continuation has no rows');
    expect(
      archivePageContract({ threads: [], has_more: false }, parent, 10, undefined, false),
    ).toEqual({ threads: [], has_more: false, complete: true });
  });

  it('rejects invalid, equal or backwards timestamps while retaining sub-millisecond distinctions', () => {
    for (const timestamp of ['', 'not-a-time', '2026-99-99T00:00:00Z']) {
      expect(() =>
        archivePageContract(
          { threads: [row(first, timestamp)], has_more: false },
          parent,
          10,
          undefined,
          false,
        ),
      ).toThrow('valid timestamp');
    }
    const time = '2026-01-01T00:00:00.123456Z';
    expect(() =>
      archivePageContract(
        { threads: [row(first, time)], has_more: false },
        parent,
        10,
        time,
        false,
      ),
    ).toThrow('did not advance');
    expect(() =>
      archivePageContract(
        { threads: [row(first, time), row(second, '2026-01-02T00:00:00Z')], has_more: false },
        parent,
        10,
        undefined,
        false,
      ),
    ).toThrow('did not advance');
    expect(
      archivePageContract(
        { threads: [row(first, time)], has_more: false },
        parent,
        10,
        '2026-01-01T00:00:00.123457Z',
        false,
      ).threads,
    ).toHaveLength(1);
  });

  it('emits an entire terminal tie group and an exact next cursor only when more rows remain', () => {
    const rows = [row(first), row(second)];
    expect(
      archivePageContract({ threads: rows, has_more: false }, parent, 2, undefined, false),
    ).toEqual({ threads: rows, has_more: false, complete: true });
    const earlier = row(second, '2025-12-31T00:00:00Z');
    expect(
      archivePageContract(
        { threads: [row(first), earlier], has_more: false },
        parent,
        1,
        undefined,
        false,
      ),
    ).toMatchObject({
      threads: [row(first)],
      has_more: true,
      complete: false,
      next_before: row(first).thread_metadata.archive_timestamp,
    });
  });

  it('rejects invalid, overflowing, duplicate or nonexclusive snowflakes', () => {
    for (const id of ['invalid', '18446744073709551616', first]) {
      expect(() => validatePage([id], 1, first)).toThrow('invalid, duplicate or nonadvancing');
    }
    expect(() => validatePage([first, first], 2)).toThrow('duplicate');
    expect(() => validatePage([first], 1, undefined, second)).toThrow('nonadvancing');
    expect(() => validatePage([first, second], 1)).toThrow('exceeded');
  });
});
