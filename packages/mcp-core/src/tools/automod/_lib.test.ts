import { describe, expect, it } from 'vitest';
import { AutoModActionType, AutoModEventType, AutoModTriggerType } from './_lib.js';

describe('AutoMod enum validation', () => {
  it.each([
    ['event', AutoModEventType, [1, 2], [0, 3]],
    ['trigger', AutoModTriggerType, [1, 3, 4, 5, 6], [0, 2, 7]],
    ['action', AutoModActionType, [1, 2, 3, 4], [0, 5]],
  ] as const)('accepts supported %s types and rejects unknown values', (_name, schema, valid, invalid) => {
    for (const value of valid) expect(schema.parse(value)).toBe(value);
    for (const value of [...invalid, 1.5, '1']) expect(schema.safeParse(value).success).toBe(false);
  });
});
