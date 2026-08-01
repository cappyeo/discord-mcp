/**
 * `token-format` check - Plan 9 Phase B.
 *
 * Validates the *shape* of `DISCORD_TOKEN` without making any network
 * calls. We read `process.env.DISCORD_TOKEN` directly (NOT the parsed
 * Config) because Config.parse rejects empty/short tokens, and we want
 * to report a clean "missing/malformed" message even when Config fails.
 *
 * Token redaction: details NEVER include the actual token. Only its
 * length and whether it begins with the literal `Bot ` prefix.
 */
import type { DoctorCheck } from './index.js';

// Discord bot tokens are typically 70+ chars (3 base64url segments
// separated by dots). 50 is a conservative lower bound that matches
// the Config schema's min(50). We accept an optional `Bot ` prefix
// because Discord.js auto-adds it when missing - but we still warn
// if it's missing because some libraries (e.g. raw fetch) require it.
const TOKEN_REGEX = /^(Bot )?[A-Za-z0-9._-]{50,}$/;

export const tokenFormatCheck: DoctorCheck = {
  id: 'token-format',
  description: 'DISCORD_TOKEN format check',
  online: false,
  async run() {
    const token = process.env.DISCORD_TOKEN;

    if (token === undefined || token === '') {
      return {
        id: 'token-format',
        status: 'fail',
        message: 'DISCORD_TOKEN is not set',
        details: { length: 0, hasBotPrefix: false },
      };
    }

    const hasBotPrefix = token.startsWith('Bot ');
    const length = token.length;

    if (!TOKEN_REGEX.test(token)) {
      return {
        id: 'token-format',
        status: 'fail',
        message: 'DISCORD_TOKEN does not match expected bot-token shape',
        details: { length, hasBotPrefix },
      };
    }

    if (!hasBotPrefix) {
      return {
        id: 'token-format',
        status: 'warn',
        message:
          'DISCORD_TOKEN is missing the "Bot " prefix (Discord.js auto-adds it, but raw REST callers may need it)',
        details: { length, hasBotPrefix },
      };
    }

    return {
      id: 'token-format',
      status: 'ok',
      message: 'DISCORD_TOKEN format looks valid',
      details: { length, hasBotPrefix },
    };
  },
};
