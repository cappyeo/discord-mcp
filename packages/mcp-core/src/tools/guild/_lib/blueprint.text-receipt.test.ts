import { describe, expect, it } from 'vitest';
import {
  appendBlueprintTextReceipt,
  BLUEPRINT_TEXT_RECEIPT_PREFIX,
} from './blueprint.text-receipt.js';

describe('blueprint text receipt', () => {
  it('appends one compact machine-readable line without changing the summary', () => {
    const text = appendBlueprintTextReceipt('Preview ready.', 'plan', {
      status: 'ready',
      plan_id: `sha256:${'a'.repeat(64)}`,
      plan_ref: `dmbpr1.${'b'.repeat(64)}`,
    });
    const [summary, line] = text.split('\n\n');

    expect(summary).toBe('Preview ready.');
    expect(line?.startsWith(BLUEPRINT_TEXT_RECEIPT_PREFIX)).toBe(true);
    expect(JSON.parse(line?.slice(BLUEPRINT_TEXT_RECEIPT_PREFIX.length) ?? '')).toEqual({
      schema_version: 'discord_mcp_blueprint_text_receipt.v1',
      phase: 'plan',
      status: 'ready',
      plan_id: `sha256:${'a'.repeat(64)}`,
      plan_ref: `dmbpr1.${'b'.repeat(64)}`,
    });
  });
});
