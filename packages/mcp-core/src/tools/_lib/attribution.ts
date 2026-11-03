import type { CallerIdentity } from '../../pieces/Tool.js';

/**
 * Discord's hard limit for message content; a footer must never push a write
 * past it.
 */
const DISCORD_CONTENT_LIMIT = 2_000;

/**
 * Attribution line for content this server publishes on a caller's behalf.
 *
 * The deployment acts as one bot for everyone, so without this a channel reads
 * as if the bot did everything. Discord shows each message's bot author, and
 * only members with access to the bot's audit log can tell which account is
 * behind it.
 *
 * Only an OAuth2 caller is named. A shared-token deployment has no per-caller
 * identity, and claiming one would be a fabrication.
 */
export function attributionFooter(caller: CallerIdentity | undefined, verb: string): string {
  if (caller === undefined) return '';
  const name = caller.username === null ? `user \`${caller.id}\`` : `@${caller.username}`;
  return `-# _${verb} by ${name} via discord-mcp_`;
}

/**
 * Append a footer to content when it fits, otherwise leave content alone.
 *
 * Truncating the caller's text to make room would silently lose their message,
 * so an over-limit message is sent unattributed instead. Discord rejects
 * content past its limit, so there is no third option.
 */
export function withAttribution(
  content: string | undefined,
  caller: CallerIdentity | undefined,
  verb: string,
): string | undefined {
  const footer = attributionFooter(caller, verb);
  if (footer === '') return content;

  const separator = content === undefined || content.length === 0 ? '' : '\n';
  const attributed = `${content ?? ''}${separator}${footer}`;
  return attributed.length <= DISCORD_CONTENT_LIMIT ? attributed : content;
}

/**
 * Attribution for a resource whose only text field is a short name or topic.
 * Same rule as `withAttribution`: credit yields to the caller's own text.
 */
export function withAttributionField(
  value: string | undefined,
  caller: CallerIdentity | undefined,
  verb: string,
  limit: number,
): string | undefined {
  const footer = attributionFooter(caller, verb);
  if (footer === '') return value;
  const separator = value === undefined || value.length === 0 ? '' : ' ';
  const attributed = `${value ?? ''}${separator}${footer}`;
  return attributed.length <= limit ? attributed : value;
}
