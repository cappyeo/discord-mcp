import { describe, expect, it } from 'vitest';

import {
  BLUEPRINT_TEXT_RECEIPT_PREFIX,
  BLUEPRINT_TEXT_RECEIPT_SCHEMA,
  parseBlueprintTextReceipt,
} from './blueprint-text-receipt.mjs';

const id = (character) => `sha256:${character.repeat(64)}`;
const target = { guild_id: '999000999000999001', bot_id: '999000999000999000' };

function output(phase, receipt) {
  return `summary\n\n${BLUEPRINT_TEXT_RECEIPT_PREFIX}${JSON.stringify({
    schema_version: BLUEPRINT_TEXT_RECEIPT_SCHEMA,
    phase,
    ...receipt,
  })}`;
}

describe('blueprint text receipt parser', () => {
  it('parses the exact plan continuation receipt without a raw token', () => {
    expect(
      parseBlueprintTextReceipt(
        output('plan', {
          status: 'ready',
          target,
          plan_id: id('a'),
          blueprint_id: id('b'),
          approval_id: id('c'),
          plan_ref: `dmbpr1.${'d'.repeat(64)}`,
        }),
        'plan',
      ),
    ).toMatchObject({ status: 'ready', target, plan_id: id('a') });
  });

  it('parses resumable apply progress and bounded retry metadata', () => {
    expect(
      parseBlueprintTextReceipt(
        output('apply', {
          status: 'partial',
          target,
          plan_id: id('a'),
          blueprint_id: id('b'),
          progress: { completed_total: 25, remaining: 17, checkpoint_version: 26 },
          error: { code: 'RATE_LIMITED', retry_after_ms: 1_500 },
          evidence_id: null,
          next_action: 'resume',
        }),
        'apply',
      ),
    ).toMatchObject({
      status: 'partial',
      progress: { completed_total: 25, remaining: 17, checkpoint_version: 26 },
      error: { code: 'RATE_LIMITED', retry_after_ms: 1_500 },
    });
  });

  it('parses terminal verified Activity Evidence', () => {
    expect(
      parseBlueprintTextReceipt(
        output('evidence', {
          status: 'verified',
          target,
          plan_id: id('a'),
          blueprint_id: id('b'),
          evidence_id: id('e'),
          verification: {
            identity_verified: true,
            guild_verified: true,
            readback: 'match',
            snapshot_unchanged: true,
            remaining: 0,
            blockers: 0,
          },
        }),
        'evidence',
      ),
    ).toMatchObject({ status: 'verified', evidence_id: id('e') });
  });

  it.each([
    ['', 'RECEIPT_COUNT_INVALID'],
    [`${output('plan', {})}\n${BLUEPRINT_TEXT_RECEIPT_PREFIX}{}`, 'RECEIPT_COUNT_INVALID'],
    [output('plan', { plan_token: 'secret' }), 'RECEIPT_INVALID'],
    [output('apply', { unexpected: true }), 'RECEIPT_SHAPE_INVALID'],
  ])('fails closed for malformed or secret-bearing output', (value, code) => {
    expect(() =>
      parseBlueprintTextReceipt(value, value.includes('apply') ? 'apply' : 'plan'),
    ).toThrow(code);
  });
});
