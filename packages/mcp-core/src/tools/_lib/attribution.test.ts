import { describe, expect, it } from 'vitest';
import type { CallerIdentity } from '../../pieces/Tool.js';
import { attributionFooter, withAttribution, withAttributionField } from './attribution.js';

const CALLER: CallerIdentity = { id: '111122223333444455', username: 'frostbun' };
const UNNAMED: CallerIdentity = { id: '111122223333444455', username: null };

describe('attribution', () => {
  it('names an OAuth2 caller and the deployment', () => {
    expect(attributionFooter(CALLER, 'Sent')).toBe('-# _Sent by @frostbun via discord-mcp_');
  });

  it('falls back to the ID when Discord returned no username', () => {
    expect(attributionFooter(UNNAMED, 'Created')).toContain('user `111122223333444455`');
  });

  it('adds nothing for a shared-token deployment', () => {
    // No per-caller identity exists there; inventing one would be a lie.
    expect(attributionFooter(undefined, 'Sent')).toBe('');
    expect(withAttribution('hello', undefined, 'Sent')).toBe('hello');
    expect(withAttribution(undefined, undefined, 'Sent')).toBeUndefined();
  });

  it('appends the footer on its own line', () => {
    expect(withAttribution('hello', CALLER, 'Sent')).toBe(
      'hello\n-# _Sent by @frostbun via discord-mcp_',
    );
  });

  it('keeps an attachments-only message inside the limit', () => {
    const result = withAttribution(undefined, CALLER, 'Sent');
    expect(result).toBe('-# _Sent by @frostbun via discord-mcp_');
  });

  it('truncates nothing: an over-limit message is sent unattributed', () => {
    // The caller's text is theirs. Losing characters to make room for a credit
    // line would be a worse outcome than the missing credit.
    const long = 'x'.repeat(2_000);
    expect(withAttribution(long, CALLER, 'Sent')).toBe(long);

    // Room to spare: the footer is appended without touching the text.
    const roomy = 'y'.repeat(1_500);
    expect(withAttribution(roomy, CALLER, 'Sent')).toBe(
      `${roomy}\n-# _Sent by @frostbun via discord-mcp_`,
    );
  });

  it('never exceeds Discord content limits when it does append', () => {
    const result = withAttribution('x'.repeat(1_000), CALLER, 'Sent') ?? '';
    expect(result.length).toBeLessThanOrEqual(2_000);
    expect(result.endsWith('via discord-mcp_')).toBe(true);
  });

  it('respects field limits for names and topics', () => {
    const result = withAttributionField('general', CALLER, 'Created', 100) ?? '';
    expect(result.length).toBeLessThanOrEqual(100);
    expect(result.startsWith('general ')).toBe(true);
    expect(result.endsWith('via discord-mcp_')).toBe(true);

    // A full-length name keeps its characters; the credit is dropped.
    const long = withAttributionField('n'.repeat(100), CALLER, 'Created', 100) ?? '';
    expect(long).toBe('n'.repeat(100));
  });

  it('leaves an empty topic alone when there is no room for the credit', () => {
    // A tiny limit leaves no space for the footer, so nothing is added.
    expect(withAttributionField(undefined, CALLER, 'Created', 10)).toBeUndefined();
  });

  it('leaves a field alone when there is no caller', () => {
    expect(withAttributionField('general', undefined, 'Created', 100)).toBe('general');
    expect(withAttributionField(undefined, undefined, 'Created', 100)).toBeUndefined();
  });
});
