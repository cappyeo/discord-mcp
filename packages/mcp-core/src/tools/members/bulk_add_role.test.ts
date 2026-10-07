import { container } from '@sapphire/pieces';
import { describe, expect, it, vi } from 'vitest';
import { ValidationError } from '../../errors/client.js';
import { compose } from '../../middleware/compose.js';
import { validateMiddleware } from '../../middleware/validate.js';
import membersBulkAddRole from './bulk_add_role.js';
import '../../container.js';

function tool() {
  const T = membersBulkAddRole;
  return new T(
    { name: 'members_bulk_add_role', path: 'inline', root: 'inline', store: null as never },
    { name: 'members_bulk_add_role', enabled: true },
  );
}

describe('members_bulk_add_role', () => {
  it('PUTs roles sequentially and continues after per-user failures', async () => {
    const requested: string[] = [];
    const reasons: Array<string | undefined> = [];
    const signals: AbortSignal[] = [];
    let active = 0;
    let maxActive = 0;
    const put = vi.fn(async (route: string, options: { reason?: string; signal?: AbortSignal }) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      requested.push(route);
      reasons.push(options.reason);
      if (options.signal !== undefined) signals.push(options.signal);
      await Promise.resolve();
      active -= 1;
      if (route.includes('111122223333444402')) throw new Error('Missing Permissions');
    });
    container.rest = { put } as never;
    const controller = new AbortController();

    const result = (await tool().run(
      {
        guild_id: '999000999000999000',
        role_id: '222233334444555566',
        user_ids: ['111122223333444401', '111122223333444402', '111122223333444403'],
        audit_reason: 'Course enrollment',
      },
      { signal: controller.signal },
    )) as {
      isError: boolean;
      content: Array<{ type: string; text: string }>;
      structuredContent: {
        role_id: string;
        succeeded_user_ids: string[];
        failed_user_ids: string[];
        succeeded_count: number;
        failed_count: number;
      };
    };

    expect(result.isError).toBe(false);
    expect(requested).toEqual([
      '/guilds/999000999000999000/members/111122223333444401/roles/222233334444555566',
      '/guilds/999000999000999000/members/111122223333444402/roles/222233334444555566',
      '/guilds/999000999000999000/members/111122223333444403/roles/222233334444555566',
    ]);
    expect(reasons).toEqual(['Course enrollment', 'Course enrollment', 'Course enrollment']);
    expect(signals).toEqual([controller.signal, controller.signal, controller.signal]);
    expect(maxActive).toBe(1);
    expect(result.structuredContent).toEqual({
      role_id: '222233334444555566',
      succeeded_user_ids: ['111122223333444401', '111122223333444403'],
      failed_user_ids: ['111122223333444402'],
      succeeded_count: 2,
      failed_count: 1,
    });
    expect(result.content[0]?.text).toContain('including idempotent no-ops');
  });

  it('honors an already-aborted caller before making a Discord request', async () => {
    const put = vi.fn();
    container.rest = { put } as never;
    const controller = new AbortController();
    const cancellation = new DOMException('caller cancelled', 'AbortError');
    controller.abort(cancellation);

    await expect(
      tool().run(
        {
          guild_id: '999000999000999000',
          role_id: '222233334444555566',
          user_ids: ['111122223333444401'],
        },
        { signal: controller.signal },
      ),
    ).rejects.toBe(cancellation);
    expect(put).not.toHaveBeenCalled();
  });

  it('rethrows caller cancellation mid-batch instead of recording a member failure', async () => {
    const controller = new AbortController();
    const cancellation = new DOMException('caller cancelled', 'AbortError');
    const put = vi.fn(async (_route: string, options: { signal?: AbortSignal }) => {
      expect(options.signal).toBe(controller.signal);
      if (put.mock.calls.length === 2) {
        controller.abort(cancellation);
        throw cancellation;
      }
    });
    container.rest = { put } as never;

    await expect(
      tool().run(
        {
          guild_id: '999000999000999000',
          role_id: '222233334444555566',
          user_ids: ['111122223333444401', '111122223333444402', '111122223333444403'],
        },
        { signal: controller.signal },
      ),
    ).rejects.toBe(cancellation);
    expect(put).toHaveBeenCalledTimes(2);
  });

  it('rejects duplicate IDs before making a Discord request', async () => {
    const put = vi.fn();
    container.rest = { put } as never;
    const t = tool();
    const dispatch = compose([validateMiddleware()], async (context) =>
      t.run(context.args, { signal: new AbortController().signal }),
    );

    try {
      await dispatch({
        tool: { name: 'members_bulk_add_role', category: 'members', idempotent: false },
        args: {
          guild_id: '999000999000999000',
          role_id: '222233334444555566',
          user_ids: ['111122223333444401', '111122223333444401'],
        },
        meta: new Map<string, unknown>([['toolPiece', t]]),
      });
      throw new Error('expected validation to reject duplicate user IDs');
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).issues[0]?.message).toMatch(/unique/i);
    }
    expect(put).not.toHaveBeenCalled();
  });

  it('is bounded, idempotent, non-destructive, and has no confirmation gate', () => {
    const t = tool();
    expect(
      t.inputSchema.user_ids.safeParse(
        Array.from({ length: 101 }, (_, index) => String(100000000000000000n + BigInt(index))),
      ).success,
    ).toBe(false);
    expect(t.annotations.destructiveHint).toBe(false);
    expect(t.annotations.idempotentHint).toBe(true);
    expect(t.preconditions).not.toContain('confirm_required');
  });
});
