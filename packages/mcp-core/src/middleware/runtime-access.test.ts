import { PermissionFlagsBits } from 'discord-api-types/v10';
import { describe, expect, it, vi } from 'vitest';
import { compose, type MiddlewareContext } from './compose.js';
import { runtimeAccessMiddleware } from './runtime-access.js';

const ctx = (name = 'messages_send'): MiddlewareContext => ({
  tool: { name, category: 'messages', idempotent: false },
  args: { channel_id: '111122223333444455' },
  meta: new Map(),
});

describe('runtime access middleware', () => {
  it('fails closed in enforce mode when evidence is unknown', async () => {
    const dispatch = compose(
      [
        runtimeAccessMiddleware({
          mode: 'enforce',
          expectedBotId: '999999999999999999',
          resolve: async () => ({
            status: 'partial',
            identityVerified: true,
            botId: '999999999999999999',
          }),
        }),
      ],
      async () => 'executed',
    );
    await expect(dispatch(ctx())).rejects.toMatchObject({ code: 'RUNTIME_ACCESS_UNKNOWN' });
  });

  it('blocks complete evidence proving a missing permission, but warn continues', async () => {
    const resolve = async () => ({
      status: 'complete' as const,
      identityVerified: true,
      botId: '999999999999999999',
      effectivePermissions: PermissionFlagsBits.ViewChannel,
    });
    const enforce = compose(
      [runtimeAccessMiddleware({ mode: 'enforce', expectedBotId: '999999999999999999', resolve })],
      async () => 'executed',
    );
    await expect(enforce(ctx())).rejects.toMatchObject({
      code: 'RUNTIME_ACCESS_DENIED',
      missingPermissions: ['SEND_MESSAGES'],
    });
    const warn = compose(
      [runtimeAccessMiddleware({ mode: 'warn', expectedBotId: '999999999999999999', resolve })],
      async () => 'executed',
    );
    await expect(warn(ctx())).resolves.toBe('executed');
  });

  it('does not gate bearer-only operations', async () => {
    const dispatch = compose(
      [runtimeAccessMiddleware({ mode: 'enforce' })],
      async () => 'executed',
    );
    await expect(dispatch(ctx('commands_edit_command_permissions'))).resolves.toBe('executed');
  });

  it('fails closed without a resolver in enforce mode and warns before continuing in warn mode', async () => {
    const warnings: string[] = [];
    const enforce = compose([runtimeAccessMiddleware({ mode: 'enforce' })], async () => 'executed');
    await expect(enforce(ctx())).rejects.toMatchObject({ code: 'RUNTIME_ACCESS_UNKNOWN' });

    const warn = compose(
      [
        runtimeAccessMiddleware({
          mode: 'warn',
          warn: (message) => warnings.push(message),
        }),
      ],
      async () => 'executed',
    );
    await expect(warn(ctx())).resolves.toBe('executed');
    expect(warnings).toEqual(['messages_send: no runtime access evidence provider is configured']);
  });

  it('treats a resolver failure as unknown and preserves cancellation', async () => {
    const warnings: string[] = [];
    const warn = compose(
      [
        runtimeAccessMiddleware({
          mode: 'warn',
          resolve: async () => {
            throw new Error('resolver offline');
          },
          warn: (message) => warnings.push(message),
        }),
      ],
      async () => 'executed',
    );
    await expect(warn(ctx())).resolves.toBe('executed');
    expect(warnings).toEqual(['messages_send: runtime access evidence provider failed']);

    const controller = new AbortController();
    controller.abort();
    const enforce = compose(
      [
        runtimeAccessMiddleware({
          mode: 'enforce',
          resolve: async () => {
            throw new Error('aborted');
          },
        }),
      ],
      async () => 'executed',
    );
    await expect(enforce({ ...ctx(), signal: controller.signal })).rejects.toThrow('aborted');
  });

  it('does not gate local or opaque-token operations with the bot resolver', async () => {
    const dispatch = compose(
      [
        runtimeAccessMiddleware({
          mode: 'enforce',
          resolve: async () => {
            throw new Error('must not be called');
          },
        }),
      ],
      async () => 'executed',
    );
    await expect(dispatch(ctx('mcp_pipeline'))).resolves.toBe('executed');
    await expect(dispatch(ctx('interactions_create_response'))).resolves.toBe('executed');
  });

  it('fails closed when a conditional member update has no actionable field', async () => {
    const resolve = vi.fn(async () => ({
      status: 'complete' as const,
      identityVerified: true,
      botId: '999999999999999999',
      effectivePermissions: 0n,
    }));
    const dispatch = compose(
      [
        runtimeAccessMiddleware({
          mode: 'enforce',
          expectedBotId: '999999999999999999',
          resolve,
        }),
      ],
      async () => 'executed',
    );
    await expect(
      dispatch({
        ...ctx('members_modify'),
        args: { guild_id: '111122223333444455', user_id: '222233334444555566' },
      }),
    ).rejects.toMatchObject({ code: 'RUNTIME_ACCESS_UNKNOWN' });
    expect(resolve).not.toHaveBeenCalled();
  });
});
