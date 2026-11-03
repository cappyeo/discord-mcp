import { describe, expect, it } from 'vitest';
import type { CallerIdentity } from '../../pieces/Tool.js';
import {
  attributionFooter,
  stripAttribution,
  withAttribution,
  withAttributionComponents,
  withAttributionField,
} from './attribution.js';

const CALLER: CallerIdentity = { id: '111122223333444455', username: 'frostbun' };
const UNNAMED: CallerIdentity = { id: '111122223333444455', username: null };
const FOOTER = '-# _Sent by <@111122223333444455> via discord-mcp_';

describe('attribution', () => {
  it('credits with a real mention the caller cannot escape by renaming', () => {
    // `@username` stayed literal text in Discord; only `<@id>` renders.
    expect(attributionFooter(CALLER, 'Sent')).toBe(FOOTER);
    expect(attributionFooter(UNNAMED, 'Sent')).toBe(FOOTER);
  });

  it('adds nothing for a shared-token deployment', () => {
    // No per-caller identity exists there; inventing one would be a lie.
    expect(attributionFooter(undefined, 'Sent')).toBe('');
    expect(withAttribution('hello', undefined, 'Sent')).toBe('hello');
    expect(withAttribution(undefined, undefined, 'Sent')).toBeUndefined();
  });

  it('appends the footer on its own line', () => {
    expect(withAttribution('hello', CALLER, 'Sent')).toBe(`hello\n${FOOTER}`);
  });

  it('keeps an attachments-only message inside the limit', () => {
    expect(withAttribution(undefined, CALLER, 'Sent')).toBe(FOOTER);
  });

  it('truncates nothing: an over-limit message is sent unattributed', () => {
    // The caller's text is theirs. Losing characters to make room for a credit
    // line would be a worse outcome than the missing credit.
    const long = 'x'.repeat(2_000);
    expect(withAttribution(long, CALLER, 'Sent')).toBe(long);

    // Room to spare: the footer is appended without touching the text.
    const roomy = 'y'.repeat(1_500);
    expect(withAttribution(roomy, CALLER, 'Sent')).toBe(`${roomy}\n${FOOTER}`);
  });

  it('replaces an earlier credit instead of stacking on every edit', () => {
    const once = withAttribution('hello', CALLER, 'Sent');
    const twice = withAttribution(once, CALLER, 'Edited') ?? '';
    // One credit line only, naming the last writer.
    expect(twice.split('via discord-mcp_')).toHaveLength(2);
    expect(twice).toContain('_Edited by');
    expect(twice).not.toContain('_Sent by');
    expect(stripAttribution(`hello\n${FOOTER}`)).toBe('hello');
    // A footer alone leaves no blank line behind.
    expect(stripAttribution(FOOTER)).toBe('');
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

  it('drops a stale credit when the fresh one does not fit', () => {
    // The caller's own text is already at the limit, so no new credit fits;
    // the previous one must not survive as a stale claim.
    const full = 'n'.repeat(100);
    expect(withAttributionField(full, CALLER, 'Updated', 100)).toBe(full);
  });

  it('passes a null field through so the caller can still clear it', () => {
    expect(withAttributionField(null, CALLER, 'Updated', 300)).toBeNull();
  });

  it('leaves an empty topic alone when there is no room for the credit', () => {
    // A tiny limit leaves no space for the footer, so nothing is added.
    expect(withAttributionField(undefined, CALLER, 'Created', 10)).toBeUndefined();
  });

  it('leaves a field alone when there is no caller', () => {
    expect(withAttributionField('general', undefined, 'Created', 100)).toBe('general');
    expect(withAttributionField(undefined, undefined, 'Created', 100)).toBeUndefined();
  });

  it('credits V2 messages with a text block, replacing an earlier one', () => {
    const container = { type: 17, components: [{ type: 10, content: 'hi' }] };
    expect(withAttributionComponents([container], CALLER, 'Sent')).toEqual([
      container,
      { type: 10, content: FOOTER },
    ]);

    const once = withAttributionComponents([container], CALLER, 'Sent');
    expect(withAttributionComponents(once, CALLER, 'Edited')).toEqual([
      container,
      { type: 10, content: '-# _Edited by <@111122223333444455> via discord-mcp_' },
    ]);

    // A full 40-component message cannot take another block.
    const full = Array.from({ length: 40 }, () => container);
    expect(withAttributionComponents(full, CALLER, 'Sent')).toHaveLength(40);
    expect(withAttributionComponents([container], undefined, 'Sent')).toEqual([container]);
  });
});
