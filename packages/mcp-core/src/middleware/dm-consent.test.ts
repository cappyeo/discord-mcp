import { describe, expect, it } from 'vitest';
import { DmConsentRejected, DmConsentRequired, WritePreview } from '../errors/client.js';
import { fingerprintPayload } from '../tools/_lib/payload-fingerprint.js';
import usersCreateDm from '../tools/users/create_dm.js';
import { compose } from './compose.js';
import { dmConsentMiddleware } from './dm-consent.js';
import { PayloadApprovalLedger } from './payload-confirmation.js';
import { writePreviewMiddleware } from './write-preview.js';

function context(args: Record<string, unknown>, rawArgs = args) {
  return {
    tool: { name: 'users_create_dm', category: 'users', idempotent: true },
    args,
    meta: new Map<string, unknown>([['rawArgs', rawArgs]]),
  };
}

describe('dmConsentMiddleware', () => {
  it('requires a preview and binds approval to recipient', async () => {
    const ledger = new PayloadApprovalLedger(() => 10_000);
    const middleware = dmConsentMiddleware({ mode: 'require', ledger, botId: 'bot-1' });
    const next = async () => 'sent';
    let preview: DmConsentRequired;
    try {
      await middleware.onCallTool?.(context({ recipient_id: 'user-1' }), next);
      throw new Error('expected consent');
    } catch (error) {
      preview = error as DmConsentRequired;
    }
    expect(preview).toBeInstanceOf(DmConsentRequired);
    const result = await middleware.onCallTool?.(
      context(
        { recipient_id: 'user-1' },
        {
          recipient_id: 'user-1',
          __consent: true,
          __consent_hash: fingerprintPayload({ recipient_id: 'user-1' }),
          __consent_id: preview!.approvalId,
        },
      ),
      next,
    );
    expect(result).toBe('sent');
  });

  it('rejects replay and changed recipients', async () => {
    const ledger = new PayloadApprovalLedger(() => 10_000);
    const middleware = dmConsentMiddleware({ mode: 'require', ledger });
    let preview: DmConsentRequired;
    try {
      await middleware.onCallTool?.(context({ recipient_id: 'user-1' }), async () => 'sent');
      throw new Error('expected consent');
    } catch (error) {
      preview = error as DmConsentRequired;
    }
    const approved = {
      recipient_id: 'user-1',
      __consent: true,
      __consent_hash: preview!.payloadHash,
      __consent_id: preview!.approvalId,
    };
    await middleware.onCallTool?.(
      context({ recipient_id: 'user-1' }, approved),
      async () => 'sent',
    );
    await expect(
      middleware.onCallTool?.(context({ recipient_id: 'user-1' }, approved), async () => 'sent'),
    ).rejects.toBeInstanceOf(DmConsentRejected);
  });

  it('preserves compatibility in advisory mode', async () => {
    const result = await dmConsentMiddleware({
      mode: 'advisory',
      ledger: new PayloadApprovalLedger(),
    }).onCallTool?.(context({ recipient_id: 'user-1' }), async () => 'sent');
    expect(result).toBe('sent');
  });

  it('lets global write preview run before consent issuance', async () => {
    const dispatch = compose(
      [
        writePreviewMiddleware('preview'),
        dmConsentMiddleware({ mode: 'require', ledger: new PayloadApprovalLedger() }),
      ],
      async () => 'sent',
    );
    await expect(dispatch(context({ recipient_id: 'user-1' }))).rejects.toBeInstanceOf(
      WritePreview,
    );
  });

  it('advertises the consent transport fields', () => {
    expect(Object.keys(usersCreateDmInputSchema())).toEqual(
      expect.arrayContaining(['recipient_id', '__consent', '__consent_hash', '__consent_id']),
    );
  });
});

function usersCreateDmInputSchema(): Record<string, unknown> {
  const T = usersCreateDm;
  return (
    new T(
      { name: 'users_create_dm', path: 'inline', root: 'inline', store: null as never },
      { name: 'users_create_dm', enabled: true },
    ) as unknown as { inputSchema: Record<string, unknown> }
  ).inputSchema;
}
