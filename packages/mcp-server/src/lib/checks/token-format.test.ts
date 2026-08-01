import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tokenFormatCheck } from './token-format.js';

const originalToken = process.env.DISCORD_TOKEN;

beforeEach(() => {
  delete process.env.DISCORD_TOKEN;
});

afterEach(() => {
  if (originalToken === undefined) {
    delete process.env.DISCORD_TOKEN;
  } else {
    process.env.DISCORD_TOKEN = originalToken;
  }
});

// 60-char token body - comfortably above the 50-char floor and shaped
// like a real Discord bot token (alnum + dot + dash + underscore).
const VALID_BODY = `${'a'.repeat(24)}.${'b'.repeat(6)}.${'c'.repeat(28)}`;

describe('tokenFormatCheck', () => {
  it('has the correct id, description, and online flag', () => {
    expect(tokenFormatCheck.id).toBe('token-format');
    expect(tokenFormatCheck.description).toBe('DISCORD_TOKEN format check');
    expect(tokenFormatCheck.online).toBe(false);
  });

  it('returns fail when DISCORD_TOKEN is unset', async () => {
    const r = await tokenFormatCheck.run(null);
    expect(r.status).toBe('fail');
    expect(r.message).toContain('not set');
    expect(r.details).toEqual({ length: 0, hasBotPrefix: false });
  });

  it('returns fail when DISCORD_TOKEN is empty string', async () => {
    process.env.DISCORD_TOKEN = '';
    const r = await tokenFormatCheck.run(null);
    expect(r.status).toBe('fail');
    expect(r.message).toContain('not set');
  });

  it('returns fail when token does not match expected shape (too short)', async () => {
    process.env.DISCORD_TOKEN = 'too-short';
    const r = await tokenFormatCheck.run(null);
    expect(r.status).toBe('fail');
    expect(r.message).toContain('does not match');
    expect(r.details?.length).toBe(9);
    expect(r.details?.hasBotPrefix).toBe(false);
  });

  it('returns fail when token contains illegal characters', async () => {
    process.env.DISCORD_TOKEN = `Bot ${'!'.repeat(60)}`;
    const r = await tokenFormatCheck.run(null);
    expect(r.status).toBe('fail');
  });

  it('returns warn when token is valid but missing "Bot " prefix', async () => {
    process.env.DISCORD_TOKEN = VALID_BODY;
    const r = await tokenFormatCheck.run(null);
    expect(r.status).toBe('warn');
    expect(r.message).toContain('Bot ');
    expect(r.details?.hasBotPrefix).toBe(false);
    expect(r.details?.length).toBe(VALID_BODY.length);
  });

  it('returns ok when token has "Bot " prefix and valid shape', async () => {
    process.env.DISCORD_TOKEN = `Bot ${VALID_BODY}`;
    const r = await tokenFormatCheck.run(null);
    expect(r.status).toBe('ok');
    expect(r.details?.hasBotPrefix).toBe(true);
    expect(r.details?.length).toBe(`Bot ${VALID_BODY}`.length);
  });

  it('NEVER includes the actual token value in details', async () => {
    process.env.DISCORD_TOKEN = `Bot ${VALID_BODY}`;
    const r = await tokenFormatCheck.run(null);
    const dump = JSON.stringify(r);
    expect(dump).not.toContain(VALID_BODY);
  });
});
