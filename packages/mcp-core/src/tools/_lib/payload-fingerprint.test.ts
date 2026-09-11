import { describe, expect, it } from 'vitest';
import { canonicalizePayload, fingerprintPayload } from './payload-fingerprint.js';

describe('payload fingerprint', () => {
  it('canonicalizes non-JSON numeric values deterministically', () => {
    expect(
      canonicalizePayload({ id: 123n, positive: Infinity, negative: -Infinity, invalid: NaN }),
    ).toBe('{"id":"123","invalid":"NaN","negative":"-Infinity","positive":"Infinity"}');
  });
  it('canonicalizes object key order and excludes authorization metadata', () => {
    const a = { z: 1, nested: { b: true, a: 'x' }, __confirm: true };
    const b = {
      nested: { a: 'x', b: true },
      z: 1,
      __confirm_hash: 'ignored',
      __confirm_id: 'ignored-too',
    };
    expect(canonicalizePayload(a)).toBe(canonicalizePayload(b));
    expect(fingerprintPayload(a)).toBe(fingerprintPayload(b));
  });

  it('changes when a payload value changes', () => {
    expect(fingerprintPayload({ content: 'one' })).not.toBe(fingerprintPayload({ content: 'two' }));
  });

  it('preserves array order because component order is observable', () => {
    expect(fingerprintPayload({ components: [{ type: 10 }, { type: 10 }] })).not.toBe(
      fingerprintPayload({ components: [{ type: 10 }, { type: 11 }] }),
    );
  });
});
