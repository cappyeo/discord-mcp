import { afterEach, describe, expect, it, vi } from 'vitest';
import { DryRunPreview } from '../errors/client.js';
import type { MiddlewareContext } from '../middleware/compose.js';
import { ConfirmRequired } from './ConfirmRequired.js';

const piece = (env: Record<string, string | undefined> = {}): ConfirmRequired => {
  return new ConfirmRequired(
    { name: 'confirm_required', path: 'inline', root: 'inline', store: null as never },
    { name: 'confirm_required', enabled: true },
    env,
  );
};

const ctx = (
  args: Record<string, unknown>,
  toolName = 'member_ban',
): MiddlewareContext<unknown> => ({
  tool: { name: toolName, category: 'moderation', idempotent: false },
  args,
  meta: new Map(),
});

describe('ConfirmRequired', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('default (MCP_DRY_RUN unset) → throws DryRunPreview without confirm', async () => {
    const p = piece({});
    await expect(p.run(ctx({ user_id: '1' }))).rejects.toBeInstanceOf(DryRunPreview);
  });

  it('default (MCP_DRY_RUN unset) + __confirm:true → still dry-run (default safe)', async () => {
    const p = piece({});
    await expect(p.run(ctx({ user_id: '1', __confirm: true }))).rejects.toBeInstanceOf(
      DryRunPreview,
    );
  });

  it('MCP_DRY_RUN=false + __confirm:true → passes', async () => {
    const p = piece({ MCP_DRY_RUN: 'false' });
    await expect(p.run(ctx({ user_id: '1', __confirm: true }))).resolves.toBeUndefined();
  });

  it('MCP_DRY_RUN=false WITHOUT __confirm → throws DryRunPreview', async () => {
    const p = piece({ MCP_DRY_RUN: 'false' });
    await expect(p.run(ctx({ user_id: '1' }))).rejects.toBeInstanceOf(DryRunPreview);
  });

  it('preview captures sanitized args (without __confirm key)', async () => {
    const p = piece({});
    try {
      await p.run(ctx({ user_id: '1', __confirm: true, reason: 'spam' }));
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(DryRunPreview);
      const dr = e as DryRunPreview;
      expect(dr.tool).toBe('member_ban');
      expect(dr.preview).toEqual({ user_id: '1', reason: 'spam' });
    }
  });

  it.each([
    'webhooks_delete_with_token',
    'interactions_delete_original_response',
  ])('redacts scoped credentials from %s previews', async (toolName) => {
    const token = 'x'.repeat(70);
    const args =
      toolName === 'webhooks_delete_with_token'
        ? { webhook_id: '123456789012345678', token }
        : {
            application_id: '123456789012345678',
            interaction_token: token,
          };

    try {
      await piece({}).run(ctx(args, toolName));
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(DryRunPreview);
      const preview = (e as DryRunPreview).preview as Record<string, unknown>;
      expect(JSON.stringify(preview)).not.toContain(token);
      expect(preview.token ?? preview.interaction_token).toBe('[REDACTED:70ch]');
      expect(preview.webhook_id ?? preview.application_id).toBe('123456789012345678');
    }
  });
});
