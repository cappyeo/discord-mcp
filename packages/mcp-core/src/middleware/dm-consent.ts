import { DmConsentRejected, DmConsentRequired } from '../errors/client.js';
import { fingerprintPayload } from '../tools/_lib/payload-fingerprint.js';
import type { MiddlewareContext, ToolMiddleware } from './compose.js';
import type { PayloadApprovalLedgerLike } from './payload-confirmation.js';

const TOOL = 'users_create_dm';

function rawArgs(ctx: MiddlewareContext<unknown>): Record<string, unknown> {
  const raw = ctx.meta.get('rawArgs');
  return raw !== null && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
}

export function dmConsentMiddleware(options: {
  mode: 'advisory' | 'require';
  ledger: PayloadApprovalLedgerLike;
  botId?: string;
}): ToolMiddleware {
  return {
    async onCallTool(ctx, next) {
      if (options.mode === 'advisory' || ctx.tool.name !== TOOL) return next();
      const args = ctx.args as { recipient_id?: unknown };
      const recipientId = typeof args.recipient_id === 'string' ? args.recipient_id : '';
      const payloadHash = fingerprintPayload({ recipient_id: recipientId });
      const target = JSON.stringify({ recipient_id: recipientId });
      const binding = {
        tool: TOOL,
        payloadHash,
        target,
        ...(options.botId === undefined ? {} : { botId: options.botId }),
      };
      const raw = rawArgs(ctx);
      const approvalId = typeof raw.__consent_id === 'string' ? raw.__consent_id : '';
      const receivedHash = typeof raw.__consent_hash === 'string' ? raw.__consent_hash : '';
      if (raw.__consent !== true || receivedHash !== payloadHash || approvalId === '') {
        const approval = options.ledger.issue(binding);
        throw new DmConsentRequired(
          TOOL,
          recipientId,
          payloadHash,
          approval.approvalId,
          approval.expiresAt,
        );
      }
      const result = options.ledger.consume(approvalId, binding);
      if (result !== 'ok') throw new DmConsentRejected(TOOL, result);
      return next();
    },
  };
}
