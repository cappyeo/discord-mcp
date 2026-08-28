import { describe, expect, it, vi } from 'vitest';
import {
  PayloadConfirmationApprovalExpired,
  PayloadConfirmationApprovalMissing,
  PayloadConfirmationApprovalReplayed,
  PayloadConfirmationMismatch,
  PayloadConfirmationRequired,
  ValidationError,
} from '../errors/client.js';
import { fingerprintPayload } from '../tools/_lib/payload-fingerprint.js';
import type { MiddlewareContext } from './compose.js';
import { compose } from './compose.js';
import {
  assessComponentsV2Payload,
  PayloadApprovalLedger,
  payloadConfirmationMiddleware,
  reviewComponentsV2,
} from './payload-confirmation.js';
import { writePreviewMiddleware } from './write-preview.js';

const channelId = '111122223333444455';
const messageId = '111122223333444466';
const simpleComponents = [{ type: 10, content: 'hello' }];
type PayloadToolName =
  | 'components_v2_send'
  | 'components_v2_edit'
  | 'components_v2_send_from_template';

function context(
  toolName: PayloadToolName,
  args: Record<string, unknown> = {
    channel_id: channelId,
    components: simpleComponents,
  },
  rawArgs: Record<string, unknown> = args,
): MiddlewareContext<unknown> {
  return {
    tool: { name: toolName, category: 'components_v2', idempotent: false },
    args,
    meta: new Map([
      ['rawArgs', rawArgs],
      ['toolPiece', { confirmation: 'payload_hash' }],
    ]),
  };
}

describe('assessComponentsV2Payload', () => {
  it('reports target-sensitive risk flags without exposing component content', () => {
    const assessment = assessComponentsV2Payload('components_v2_edit', {
      channel_id: channelId,
      message_id: messageId,
      allowed_mentions: { parse: ['everyone'] },
      components: [
        {
          type: 1,
          components: [{ type: 2, style: 5, url: 'https://example.test/button' }],
        },
        { type: 10, content: 'https://example.test/notice' },
      ],
    });
    expect(assessment).toEqual({
      componentCount: 2,
      riskFlags: [
        'edit_existing_message',
        'allowed_mentions',
        'external_urls',
        'interactive_components',
      ],
    });
  });

  it('marks a large top-level layout as near the component cap', () => {
    const assessment = assessComponentsV2Payload('components_v2_send', {
      components: Array.from({ length: 32 }, () => ({ type: 10, content: 'x' })),
    });
    expect(assessment.riskFlags).toContain('component_count_near_limit');
  });

  it('keeps malformed URL-like values bounded when building the review', () => {
    const review = reviewComponentsV2([{ type: 10, content: 'https://%' }]);
    expect(review.externalUrlHosts).toEqual([]);
  });
});

describe('reviewComponentsV2', () => {
  it('returns bounded structural evidence without raw text or identifiers', () => {
    const review = reviewComponentsV2([
      { type: 10, content: 'private announcement' },
      {
        type: 1,
        components: [
          { type: 2, style: 1, custom_id: 'approve_release', label: 'Approve' },
          { type: 2, style: 5, url: 'https://example.test/release' },
        ],
      },
    ]);
    expect(review).toMatchObject({
      totalNodes: 4,
      typeCounts: { TextDisplay: 1, ActionRow: 1, Button: 2 },
      textNodes: 1,
      maxTextLength: 20,
      externalUrlHosts: ['example.test'],
      interactiveCount: 2,
      customIdLengths: [15],
    });
    expect(JSON.stringify(review)).not.toContain('private announcement');
    expect(JSON.stringify(review)).not.toContain('approve_release');
  });
});

describe('payloadConfirmationMiddleware', () => {
  it('fails closed when the middleware receives a non-object argument', async () => {
    const next = vi.fn();
    const ctx = {
      tool: { name: 'components_v2_send', category: 'components_v2', idempotent: false },
      args: null,
      meta: new Map([
        ['rawArgs', null],
        ['toolPiece', { confirmation: 'payload_hash' }],
      ]),
    } as MiddlewareContext<unknown>;
    await expect(
      payloadConfirmationMiddleware({ env: { MCP_DRY_RUN: 'false' } }).onCallTool!(ctx, next),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns a bounded preview when confirmation or dry-run approval is absent', async () => {
    const next = vi.fn();
    const ctx = context('components_v2_send');
    await expect(
      payloadConfirmationMiddleware({ env: { MCP_DRY_RUN: 'false' } }).onCallTool!(ctx, next),
    ).rejects.toBeInstanceOf(PayloadConfirmationRequired);
    expect(next).not.toHaveBeenCalled();
    try {
      await payloadConfirmationMiddleware({ env: { MCP_DRY_RUN: 'false' } }).onCallTool!(ctx, next);
    } catch (error) {
      const required = error as PayloadConfirmationRequired;
      expect(required.payloadHash).toMatch(/^[a-f0-9]{64}$/u);
      expect(required.preview).toMatchObject({
        tool: 'components_v2_send',
        component_count: 1,
        component_review: {
          totalNodes: 1,
          textNodes: 1,
          maxTextLength: 5,
        },
        payload_hash: required.payloadHash,
        risk_flags: [],
      });
      expect(JSON.stringify(required.preview)).not.toContain('hello');
      expect(JSON.stringify(required.preview)).not.toContain('__confirm');
      expect(required.preview.approval_id).toBe(required.approvalId);
      expect(required.preview.approval_expires_at).toBeTypeOf('string');
    }
  });

  it('does not allow a missing metadata entry to bypass a known high-risk tool', async () => {
    const next = vi.fn();
    const ctx = context('components_v2_send');
    ctx.meta.delete('toolPiece');
    await expect(
      payloadConfirmationMiddleware({ env: { MCP_DRY_RUN: 'false' } }).onCallTool!(ctx, next),
    ).rejects.toBeInstanceOf(PayloadConfirmationRequired);
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects a stale or malformed hash before invoking the handler', async () => {
    const next = vi.fn();
    const args = { channel_id: channelId, components: simpleComponents };
    const ctx = context('components_v2_send', args, {
      ...args,
      __confirm: true,
      __confirm_hash: '0'.repeat(64),
    });
    await expect(
      payloadConfirmationMiddleware({ env: { MCP_DRY_RUN: 'false' } }).onCallTool!(ctx, next),
    ).rejects.toBeInstanceOf(PayloadConfirmationMismatch);
    expect(next).not.toHaveBeenCalled();
  });

  it('reports an invalid hash without echoing the supplied value', async () => {
    const next = vi.fn();
    const args = { channel_id: channelId, components: simpleComponents };
    await expect(
      payloadConfirmationMiddleware({ env: { MCP_DRY_RUN: 'false' } }).onCallTool!(
        context('components_v2_send', args, {
          ...args,
          __confirm: true,
          __confirm_hash: 'not-a-hash',
          __confirm_id: '00000000-0000-4000-8000-000000000000',
        }),
        next,
      ),
    ).rejects.toMatchObject({
      code: 'PAYLOAD_CONFIRMATION_MISMATCH',
      receivedHash: '[invalid]',
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('invokes the handler only for the exact hash with dry-run disabled', async () => {
    const next = vi.fn().mockResolvedValue({ ok: true });
    const middleware = payloadConfirmationMiddleware({ env: { MCP_DRY_RUN: 'false' } });
    const args = { channel_id: channelId, components: simpleComponents };
    const preview = context('components_v2_send', args);
    let approvalId = '';
    try {
      await middleware.onCallTool!(preview, next);
    } catch (error) {
      approvalId = (error as PayloadConfirmationRequired).approvalId;
    }
    const ctx = context('components_v2_send', args, {
      ...args,
      __confirm: true,
      __confirm_hash: fingerprintPayload(args),
      __confirm_id: approvalId,
    });
    await expect(middleware.onCallTool!(ctx, next)).resolves.toEqual({ ok: true });
    expect(next).toHaveBeenCalledOnce();
  });

  it('returns a fresh preview when the hash is valid but the one-time ID is omitted', async () => {
    const next = vi.fn();
    const args = { channel_id: channelId, components: simpleComponents };
    await expect(
      payloadConfirmationMiddleware({ env: { MCP_DRY_RUN: 'false' } }).onCallTool!(
        context('components_v2_send', args, {
          ...args,
          __confirm: true,
          __confirm_hash: fingerprintPayload(args),
        }),
        next,
      ),
    ).rejects.toBeInstanceOf(PayloadConfirmationRequired);
    expect(next).not.toHaveBeenCalled();
  });

  it('always previews when MCP_DRY_RUN is enabled, even with a matching hash', async () => {
    const next = vi.fn();
    const args = { channel_id: channelId, components: simpleComponents };
    const ctx = context('components_v2_send', args, {
      ...args,
      __confirm: true,
      __confirm_hash: fingerprintPayload(args),
    });
    await expect(
      payloadConfirmationMiddleware({ env: { MCP_DRY_RUN: 'true' } }).onCallTool!(ctx, next),
    ).rejects.toBeInstanceOf(PayloadConfirmationRequired);
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects malformed Components V2 before creating an approval', async () => {
    const next = vi.fn();
    const ctx = context('components_v2_edit', {
      channel_id: channelId,
      message_id: messageId,
      components: [{ type: 10 }],
    });
    await expect(
      payloadConfirmationMiddleware({ env: { MCP_DRY_RUN: 'false' } }).onCallTool!(ctx, next),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects an unknown template before creating an approval', async () => {
    const next = vi.fn();
    await expect(
      payloadConfirmationMiddleware({ env: { MCP_DRY_RUN: 'false' } }).onCallTool!(
        context('components_v2_send_from_template', {
          channel_id: channelId,
          template: 'does_not_exist',
          vars: {},
        }),
        next,
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(next).not.toHaveBeenCalled();
  });

  it('binds template approval to the interpolated tree rather than only the template name', async () => {
    const env = { MCP_DRY_RUN: 'false' };
    const middleware = payloadConfirmationMiddleware({ env });
    const args = {
      channel_id: channelId,
      template: 'announcement',
      vars: { title: 'Hello', body: 'World', cta_label: 'Open', cta_url: 'https://example.test' },
    };
    const next = vi.fn().mockResolvedValue({ ok: true });
    const previewContext = context('components_v2_send_from_template', args);
    await expect(middleware.onCallTool!(previewContext, next)).rejects.toMatchObject({
      code: 'PAYLOAD_CONFIRMATION_REQUIRED',
    });
    const error = await (async () => {
      try {
        await middleware.onCallTool!(previewContext, next);
      } catch (caught) {
        return caught as PayloadConfirmationRequired;
      }
      throw new Error('expected preview');
    })();
    const approved = context('components_v2_send_from_template', args, {
      ...args,
      __confirm: true,
      __confirm_hash: error.payloadHash,
      __confirm_id: error.approvalId,
    });
    await expect(middleware.onCallTool!(approved, next)).resolves.toEqual({
      ok: true,
    });
    expect(next).toHaveBeenCalledOnce();
  });

  it('consumes an approval once and rejects replayed non-idempotent sends', async () => {
    const now = 10_000;
    const ledger = new PayloadApprovalLedger(() => now);
    const env = { MCP_DRY_RUN: 'false' };
    const args = { channel_id: channelId, components: simpleComponents };
    const next = vi.fn().mockResolvedValue({ ok: true });
    const preview = context('components_v2_send', args);
    let approvalId = '';
    try {
      await payloadConfirmationMiddleware({ env, ledger }).onCallTool!(preview, next);
    } catch (error) {
      approvalId = (error as PayloadConfirmationRequired).approvalId;
    }
    const approvedArgs = {
      ...args,
      __confirm: true,
      __confirm_hash: fingerprintPayload(args),
      __confirm_id: approvalId,
    };
    await payloadConfirmationMiddleware({ env, ledger }).onCallTool!(
      context('components_v2_send', args, approvedArgs),
      next,
    );
    await expect(
      payloadConfirmationMiddleware({ env, ledger }).onCallTool!(
        context('components_v2_send', args, approvedArgs),
        next,
      ),
    ).rejects.toBeInstanceOf(PayloadConfirmationApprovalReplayed);
    expect(next).toHaveBeenCalledOnce();
  });

  it('rejects an expired approval before invoking the handler', async () => {
    let now = 10_000;
    const ledger = new PayloadApprovalLedger(() => now, 100);
    const env = { MCP_DRY_RUN: 'false' };
    const args = { channel_id: channelId, components: simpleComponents };
    const next = vi.fn().mockResolvedValue({ ok: true });
    const middleware = payloadConfirmationMiddleware({ env, ledger });
    let approvalId = '';
    try {
      await middleware.onCallTool!(context('components_v2_send', args), next);
    } catch (error) {
      approvalId = (error as PayloadConfirmationRequired).approvalId;
    }
    now += 101;
    await expect(
      middleware.onCallTool!(
        context('components_v2_send', args, {
          ...args,
          __confirm: true,
          __confirm_hash: fingerprintPayload(args),
          __confirm_id: approvalId,
        }),
        next,
      ),
    ).rejects.toBeInstanceOf(PayloadConfirmationApprovalExpired);
    expect(next).not.toHaveBeenCalled();
  });

  it('keeps an expired approval distinguishable for a bounded grace period', async () => {
    let now = 10_000;
    const ledger = new PayloadApprovalLedger(() => now, 100);
    const env = { MCP_DRY_RUN: 'false' };
    const args = { channel_id: channelId, components: simpleComponents };
    const next = vi.fn().mockResolvedValue({ ok: true });
    const middleware = payloadConfirmationMiddleware({ env, ledger });
    let approvalId = '';
    try {
      await middleware.onCallTool!(context('components_v2_send', args), next);
    } catch (error) {
      approvalId = (error as PayloadConfirmationRequired).approvalId;
    }
    now += 101;
    const approved = context('components_v2_send', args, {
      ...args,
      __confirm: true,
      __confirm_hash: fingerprintPayload(args),
      __confirm_id: approvalId,
    });
    await expect(middleware.onCallTool!(approved, next)).rejects.toBeInstanceOf(
      PayloadConfirmationApprovalExpired,
    );
    await expect(middleware.onCallTool!(approved, next)).rejects.toBeInstanceOf(
      PayloadConfirmationApprovalExpired,
    );
    now += 101;
    await expect(middleware.onCallTool!(approved, next)).rejects.toBeInstanceOf(
      PayloadConfirmationApprovalMissing,
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects a valid hash when the approval is from another process ledger', async () => {
    const env = { MCP_DRY_RUN: 'false' };
    const args = { channel_id: channelId, components: simpleComponents };
    const source = payloadConfirmationMiddleware({
      env,
      ledger: new PayloadApprovalLedger(() => 10_000),
    });
    const target = payloadConfirmationMiddleware({
      env,
      ledger: new PayloadApprovalLedger(() => 10_000),
    });
    const next = vi.fn().mockResolvedValue({ ok: true });
    let approvalId = '';
    let payloadHash = '';
    try {
      await source.onCallTool!(context('components_v2_send', args), next);
    } catch (error) {
      const required = error as PayloadConfirmationRequired;
      approvalId = required.approvalId;
      payloadHash = required.payloadHash;
    }
    await expect(
      target.onCallTool!(
        context('components_v2_send', args, {
          ...args,
          __confirm: true,
          __confirm_hash: payloadHash,
          __confirm_id: approvalId,
        }),
        next,
      ),
    ).rejects.toBeInstanceOf(PayloadConfirmationApprovalMissing);
    expect(next).not.toHaveBeenCalled();
  });

  it('binds the ledger to tool and target independently of the payload hash', () => {
    const ledger = new PayloadApprovalLedger(() => 10_000);
    const binding = {
      tool: 'components_v2_send',
      payloadHash: 'a'.repeat(64),
      target: JSON.stringify({ channel_id: channelId }),
    };
    const { approvalId } = ledger.issue(binding);
    expect(ledger.consume(approvalId, { ...binding, tool: 'components_v2_edit' })).toBe('mismatch');
    expect(
      ledger.consume(approvalId, { ...binding, target: JSON.stringify({ channel_id: messageId }) }),
    ).toBe('mismatch');
    expect(ledger.consume(approvalId, binding)).toBe('ok');
    expect(ledger.consume(approvalId, binding)).toBe('replayed');
  });

  it('binds an approval to the expected bot when the deployment supplies one', () => {
    const ledger = new PayloadApprovalLedger(() => 10_000);
    const binding = {
      tool: 'components_v2_send',
      payloadHash: 'b'.repeat(64),
      target: JSON.stringify({ channel_id: channelId }),
      botId: '987654321098765432',
    };
    const { approvalId } = ledger.issue(binding);
    expect(ledger.consume(approvalId, { ...binding, botId: '987654321098765433' })).toBe(
      'mismatch',
    );
    expect(ledger.consume(approvalId, binding)).toBe('ok');
  });

  it('rejects applying a preview through a different locked bot middleware', async () => {
    const ledger = new PayloadApprovalLedger(() => 10_000);
    const args = { channel_id: channelId, components: simpleComponents };
    const source = payloadConfirmationMiddleware({
      env: { MCP_DRY_RUN: 'false' },
      ledger,
      botId: '987654321098765432',
    });
    const target = payloadConfirmationMiddleware({
      env: { MCP_DRY_RUN: 'false' },
      ledger,
      botId: '987654321098765433',
    });
    const next = vi.fn().mockResolvedValue({ ok: true });
    let preview: PayloadConfirmationRequired | undefined;
    try {
      await source.onCallTool!(context('components_v2_send', args), next);
    } catch (error) {
      preview = error as PayloadConfirmationRequired;
    }
    expect(preview).toBeDefined();
    await expect(
      target.onCallTool!(
        context('components_v2_send', args, {
          ...args,
          __confirm: true,
          __confirm_hash: preview?.payloadHash,
          __confirm_id: preview?.approvalId,
        }),
        next,
      ),
    ).rejects.toMatchObject({ code: 'PAYLOAD_CONFIRMATION_APPROVAL_MISMATCH' });
    expect(next).not.toHaveBeenCalled();
  });

  it('does not issue or consume an approval when global write preview blocks the call', async () => {
    const ledger = new PayloadApprovalLedger(() => 10_000);
    const next = vi.fn().mockResolvedValue({ ok: true });
    const ctx = context('components_v2_send');
    ctx.meta.set('toolPiece', {
      confirmation: 'payload_hash',
      annotations: { readOnlyHint: false },
    });
    const dispatch = compose(
      [
        writePreviewMiddleware('preview'),
        payloadConfirmationMiddleware({ env: { MCP_DRY_RUN: 'false' }, ledger }),
      ],
      async () => next(),
    );
    await expect(dispatch(ctx)).rejects.toMatchObject({ code: 'WRITE_PREVIEW' });
    expect(ledger.size).toBe(0);
    expect(next).not.toHaveBeenCalled();
  });

  it('atomically lets only one concurrent call consume an approval', async () => {
    const ledger = new PayloadApprovalLedger(() => 10_000);
    const env = { MCP_DRY_RUN: 'false' };
    const args = { channel_id: channelId, components: simpleComponents };
    const next = vi.fn().mockResolvedValue({ ok: true });
    const middleware = payloadConfirmationMiddleware({ env, ledger });
    let approvalId = '';
    let payloadHash = '';
    try {
      await middleware.onCallTool!(context('components_v2_send', args), next);
    } catch (error) {
      const preview = error as PayloadConfirmationRequired;
      approvalId = preview.approvalId;
      payloadHash = preview.payloadHash;
    }
    const approved = () =>
      context('components_v2_send', args, {
        ...args,
        __confirm: true,
        __confirm_hash: payloadHash,
        __confirm_id: approvalId,
      });
    const outcomes = await Promise.allSettled([
      middleware.onCallTool!(approved(), next),
      middleware.onCallTool!(approved(), next),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);
    expect(
      (outcomes.find((outcome) => outcome.status === 'rejected') as PromiseRejectedResult).reason,
    ).toBeInstanceOf(PayloadConfirmationApprovalReplayed);
    expect(next).toHaveBeenCalledOnce();
  });

  it('bounds pending and terminal approval records together', () => {
    const ledger = new PayloadApprovalLedger(() => 10_000);
    const binding = { tool: 'components_v2_send', payloadHash: 'a'.repeat(64), target: '{}' };
    for (let index = 0; index < 2_100; index += 1) ledger.issue(binding);
    expect(ledger.size).toBeLessThanOrEqual(1_024);
  });

  it('uses the safe default TTL for an invalid configured TTL', () => {
    const ledger = new PayloadApprovalLedger(() => 10_000, 0);
    const { expiresAt } = ledger.issue({
      tool: 'components_v2_send',
      payloadHash: 'c'.repeat(64),
      target: '{}',
    });
    expect(expiresAt).toBe(10_000 + 5 * 60_000);
  });

  it('bounds terminal replay records after many successful consumes', () => {
    const ledger = new PayloadApprovalLedger(() => 10_000);
    const binding = { tool: 'components_v2_send', payloadHash: 'd'.repeat(64), target: '{}' };
    for (let index = 0; index < 1_025; index += 1) {
      const { approvalId } = ledger.issue(binding);
      expect(ledger.consume(approvalId, binding)).toBe('ok');
    }
    expect(ledger.size).toBeLessThanOrEqual(1_024);
  });
});
