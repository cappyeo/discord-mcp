/**
 * The logger must not be a credential-disclosure channel.
 *
 * `@discordjs/rest` throws errors carrying the full request URL and, on
 * DiscordAPIError, the request body. Webhook and interaction tokens live in
 * the URL path, so pino's default `err` serializer wrote bearer credentials
 * and unredacted message content to stderr at the default log level — any
 * operator with journal access, and any log shipper, received them.
 */
import { PassThrough } from 'node:stream';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { redactCredentialUrl } from './telemetry/redact.js';

/** Mirrors createLogger's serializer against a capturable destination. */
function captureLogger(): { logger: pino.Logger; output: () => string } {
  const chunks: string[] = [];
  const stream = new PassThrough();
  stream.on('data', (c) => chunks.push(String(c)));
  // Rebuild the same serializer wiring createLogger uses. Importing
  // createLogger directly would write to fd 2, which vitest does not capture.
  const logger = pino(
    {
      level: 'warn',
      serializers: {
        err: (err: Error) => {
          const base = pino.stdSerializers.err(err) as unknown as Record<string, unknown>;
          delete base.requestBody;
          delete base.rawError;
          delete base.body;
          for (const key of ['url', 'message', 'stack'] as const) {
            if (typeof base[key] === 'string') base[key] = redactCredentialUrl(base[key]);
          }
          return base;
        },
      },
    },
    stream,
  );
  return { logger, output: () => chunks.join('') };
}

/** Same shape @discordjs/rest throws: url + requestBody + rawError. */
class DiscordAPIError extends Error {
  public readonly status = 401;
  public readonly code = 50027;
  public readonly url =
    'https://discord.com/api/v10/webhooks/123456789012345678/SUPER_SECRET_WEBHOOK_TOKEN';
  public readonly requestBody = { json: { content: 'private message body' } };
  public readonly rawError = { message: 'Invalid Webhook Token', code: 50027 };
}

function fakeDiscordApiError(): Error {
  return new DiscordAPIError(
    'Invalid Webhook Token at https://discord.com/api/v10/webhooks/123456789012345678/SUPER_SECRET_WEBHOOK_TOKEN',
  );
}

describe('logger err serializer', () => {
  it('strips the webhook token from url, message and stack', () => {
    const { logger, output } = captureLogger();
    logger.warn({ err: fakeDiscordApiError() }, 'tool error');
    const out = output();
    expect(out).not.toContain('SUPER_SECRET_WEBHOOK_TOKEN');
    expect(out).toContain(':token');
  });

  it('drops the request body entirely', () => {
    const { logger, output } = captureLogger();
    logger.warn({ err: fakeDiscordApiError() }, 'tool error');
    const out = output();
    expect(out).not.toContain('private message body');
    expect(out).not.toContain('requestBody');
    expect(out).not.toContain('rawError');
  });

  it('still records the diagnostic fields an operator needs', () => {
    const { logger, output } = captureLogger();
    logger.warn({ err: fakeDiscordApiError() }, 'tool error');
    const parsed = JSON.parse(output().trim()) as { err: Record<string, unknown> };
    expect(parsed.err.type).toBe('DiscordAPIError');
    expect(parsed.err.status).toBe(401);
    expect(parsed.err.code).toBe(50027);
    expect(parsed.err.message).toContain('Invalid Webhook Token');
  });

  it('strips interaction tokens and query strings too', () => {
    const { logger, output } = captureLogger();
    const err = new Error('boom');
    Object.assign(err, {
      url: 'https://discord.com/api/v10/interactions/123456789012345678/INTERACTION_SECRET/callback?wait=true',
    });
    logger.warn({ err }, 'tool error');
    const out = output();
    expect(out).not.toContain('INTERACTION_SECRET');
    expect(out).not.toContain('wait=true');
  });
});
