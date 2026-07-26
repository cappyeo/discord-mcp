import { describe, expect, it } from 'vitest';
import { redactRoute } from './redact.js';

describe('redactRoute', () => {
  it('replaces a single snowflake ID with :id', () => {
    expect(redactRoute('/channels/123456789012345678')).toBe('/channels/:id');
  });

  it('replaces multiple snowflake IDs in the same path', () => {
    expect(redactRoute('/channels/123456789012345678/messages/987654321098765432')).toBe(
      '/channels/:id/messages/:id',
    );
  });

  it('preserves the @me literal verbatim', () => {
    expect(redactRoute('/users/@me/guilds/111122223333444455')).toBe('/users/@me/guilds/:id');
  });

  it('preserves the @original literal (interactions edge case)', () => {
    expect(redactRoute('/webhooks/123456789012345678/abc/messages/@original')).toBe(
      '/webhooks/:id/:token/messages/@original',
    );
  });

  it('collapses the webhook token — it is a bearer credential, not an ID', () => {
    // Anyone holding this segment can execute the webhook without the bot
    // token. It is not a snowflake, so the digit rule alone leaves it intact.
    const out = redactRoute(
      '/webhooks/123456789012345678/xN8s-QK_secretTokenValue.aBcDeF/messages/987654321098765432',
    );
    expect(out).toBe('/webhooks/:id/:token/messages/:id');
    expect(out).not.toContain('secretTokenValue');
  });

  it('collapses the interaction token', () => {
    const out = redactRoute('/interactions/123456789012345678/aW50ZXJhY3Rpb25Ub2tlbg/callback');
    expect(out).toBe('/interactions/:id/:token/callback');
    expect(out).not.toContain('aW50ZXJhY3Rpb25Ub2tlbg');
  });

  it('leaves a bare /webhooks/:id route alone', () => {
    expect(redactRoute('/webhooks/123456789012345678')).toBe('/webhooks/:id');
  });

  it('does not invent a token segment for non-credential routes', () => {
    // `webhooks` only carries a token when it directly follows the id.
    expect(redactRoute('/channels/123456789012345678/webhooks')).toBe('/channels/:id/webhooks');
  });

  it('strips query strings entirely', () => {
    expect(redactRoute('/guilds/111122223333444455/regions?limit=10')).toBe('/guilds/:id/regions');
  });

  it('strips multi-param query strings without leaking values', () => {
    expect(
      redactRoute('/channels/111122223333444455/messages?limit=50&before=987654321098765432'),
    ).toBe('/channels/:id/messages');
  });

  it('leaves short numeric segments alone (e.g. API version)', () => {
    // 10 is an API version, not a snowflake. The regex matches 17–20
    // digits, so this stays put.
    expect(redactRoute('/v10/guilds/111122223333444455')).toBe('/v10/guilds/:id');
  });

  it('handles paths without IDs unchanged', () => {
    expect(redactRoute('/gateway/bot')).toBe('/gateway/bot');
  });

  it('handles a 17-digit snowflake (lower bound)', () => {
    expect(redactRoute('/channels/12345678901234567')).toBe('/channels/:id');
  });

  it('handles a 20-digit snowflake (upper bound)', () => {
    expect(redactRoute('/channels/12345678901234567890')).toBe('/channels/:id');
  });
});
