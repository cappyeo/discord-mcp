import pino, { type Logger } from 'pino';
import type { Config } from './config.js';
import { redactCredentialUrl } from './telemetry/redact.js';

/**
 * Error serializer that cannot leak a Discord credential.
 *
 * `@discordjs/rest` throws `DiscordAPIError` / `HTTPError`, which carry the
 * full request `url` and, on `DiscordAPIError`, the `requestBody` that was
 * sent. Webhook and interaction tokens live in the URL *path*, so pino's
 * default `err` serializer writes bearer credentials — and unredacted message
 * content — to stderr at the default log level.
 *
 * Call sites should log a whitelisted projection rather than `{ err }` at all;
 * this exists so that the next time someone does log `{ err }`, it is not a
 * credential disclosure.
 */
function serializeErr(err: Error): Record<string, unknown> {
  const base = pino.stdSerializers.err(err) as unknown as Record<string, unknown>;
  // The two carriers of request payloads on @discordjs/rest errors.
  delete base.requestBody;
  delete base.rawError;
  delete base.body;
  for (const key of ['url', 'message', 'stack'] as const) {
    if (typeof base[key] === 'string') {
      base[key] = redactCredentialUrl(base[key]);
    }
  }
  return base;
}

export function createLogger(config: Config): Logger {
  return pino(
    { level: config.LOG_LEVEL, serializers: { err: serializeErr } },
    pino.destination(2), // stderr — stdio reserves stdout for JSON-RPC
  );
}
