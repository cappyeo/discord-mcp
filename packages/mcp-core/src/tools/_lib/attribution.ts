import type { CallerIdentity } from '../../pieces/Tool.js';

/**
 * Discord's hard limit for message content; a footer must never push a write
 * past it.
 */
const DISCORD_CONTENT_LIMIT = 2_000;

/**
 * Every credit line ends like this, whoever wrote it and whenever it was
 * applied. Edits strip the old one before adding their own so credit follows
 * the last writer instead of piling up.
 */
const CREDIT_SUFFIX = /-# _[^\n]* via discord-mcp_$/u;

/**
 * Attribution line for content this server publishes on a caller's behalf.
 *
 * The deployment acts as one bot for everyone, so without this a channel reads
 * as if the bot did everything. Discord shows each message's bot author, and
 * only members with access to the bot's audit log can tell which account is
 * behind it.
 *
 * The snowflake form is a real Discord mention that always renders as the
 * user's current name; `@username` stayed literal text.
 *
 * Only an OAuth2 caller is named. A shared-token deployment has no per-caller
 * identity, and claiming one would be a fabrication.
 */
export function attributionFooter(caller: CallerIdentity | undefined, verb: string): string {
  if (caller === undefined) return '';
  return `-# _${verb} by <@${caller.id}> via discord-mcp_`;
}

/** Drop the credit line this server added earlier, if any. */
export function stripAttribution(text: string): string {
  return text.replace(CREDIT_SUFFIX, '').replace(/\n$/u, '');
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
  const own = stripAttribution(content ?? '');
  const attributed = own === '' ? footer : `${own}\n${footer}`;
  return attributed.length <= DISCORD_CONTENT_LIMIT ? attributed : content;
}

/**
 * Attribution for a resource whose only text field is a short name or topic.
 * Same rule as `withAttribution`: credit yields to the caller's own text.
 */
export function withAttributionField(
  value: string | undefined | null,
  caller: CallerIdentity | undefined,
  verb: string,
  limit: number,
): string | undefined | null {
  // A nullable field being cleared has nothing to credit.
  if (typeof value !== 'string') return value;
  const footer = attributionFooter(caller, verb);
  const own = stripAttribution(value);
  if (footer === '') return own;
  const attributed = own === '' ? footer : `${own} ${footer}`;
  // Too long: keep the caller's own text, without the stale credit.
  return attributed.length <= limit ? attributed : own;
}

/**
 * Components V2 messages have no content field, so the credit is its own text
 * block. Any credit block already present is replaced rather than duplicated.
 */
export function withAttributionComponents(
  components: readonly unknown[],
  caller: CallerIdentity | undefined,
  verb: string,
): unknown[] {
  const kept = components.filter((node) => {
    if (typeof node !== 'object' || node === null || !('type' in node) || node.type !== 10)
      return true;
    return !(
      'content' in node &&
      typeof node.content === 'string' &&
      CREDIT_SUFFIX.test(node.content)
    );
  });
  const footer = attributionFooter(caller, verb);
  // 40 is Discord's cap for a whole V2 message; adding a 41st would be rejected.
  if (footer === '' || kept.length >= 40) return kept;
  return [...kept, { type: 10, content: footer }];
}
