import { container } from '@sapphire/pieces';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../config.js';
import '../../container.js';
import { projectMessage } from '../messages/_lib/message.js';
import { archivePage } from './archive-page.js';
import { validatePage } from './page.js';

const parent = '111122223333444455';
function thread(id: number, time: string) {
  return {
    id: String(999000999000000000n + BigInt(id)),
    parent_id: parent,
    thread_metadata: { archive_timestamp: time },
  };
}
describe('monitoring continuation contracts', () => {
  it('does not split a tied archive boundary or silently call omitted rows complete', () => {
    container.config = loadConfig({ DISCORD_TOKEN: 'x'.repeat(60) });
    const raw = {
      threads: [
        thread(1, '2026-01-03T00:00:00Z'),
        thread(2, '2026-01-02T00:00:00Z'),
        thread(3, '2026-01-02T00:00:00Z'),
      ],
      has_more: true,
    };
    const page = archivePage(raw, parent, 2, undefined, false);
    expect(page.threads).toHaveLength(1);
    expect(page.has_more).toBe(true);
    expect(page.complete).toBe(false);
  });
  it('fails an unpageable tie and missing authoritative has_more', () => {
    container.config = loadConfig({ DISCORD_TOKEN: 'x'.repeat(60) });
    expect(() =>
      archivePage(
        {
          threads: [thread(1, '2026-01-02T00:00:00Z'), thread(2, '2026-01-02T00:00:00Z')],
          has_more: true,
        },
        parent,
        1,
        undefined,
        false,
      ),
    ).toThrow('cannot be safely paged');
    expect(() => archivePage({ threads: [] }, parent, 100, undefined, false)).toThrow(
      'Invalid Discord archive page',
    );
  });
  it('preserves Discord sub-millisecond archive cursor precision and sorts joined ID pages', () => {
    container.config = loadConfig({ DISCORD_TOKEN: 'x'.repeat(60) });
    const earlier = thread(1, '2026-01-01T00:00:00.855700+00:00');
    expect(
      archivePage(
        { threads: [earlier], has_more: false },
        parent,
        1,
        '2026-01-01T00:00:00.855793+00:00',
        false,
      ).complete,
    ).toBe(true);
    const joined = archivePage(
      { threads: [thread(1, ''), thread(2, '')], has_more: true },
      parent,
      2,
      undefined,
      true,
    );
    expect(joined.next_before).toBe(earlier.id);
  });
  it('rejects duplicate/exclusive-cursor violations and oversized pages', () => {
    const id = '999000999000000001';
    expect(() => validatePage([id, id], 2)).toThrow();
    expect(() => validatePage([id], 1, undefined, id)).toThrow();
    expect(() => validatePage([id], 0)).toThrow();
  });
  it('preserves reply identity and treats missing edit timestamp as unedited', () => {
    const m = {
      id: '999000999000000001',
      channel_id: parent,
      content: '',
      timestamp: '2026-01-01Z',
      author: { id: '999000999000000002', username: 'owner', bot: false },
      message_reference: { message_id: '999000999000000003' },
      referenced_message: { author: { id: '999000999000000004' } },
    };
    expect(projectMessage(m as never)).toMatchObject({
      edited: false,
      referenced_author_id: '999000999000000004',
      referenced_message_state: 'present',
    });
  });
});
