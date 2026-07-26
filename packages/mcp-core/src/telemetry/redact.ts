/**
 * Discord REST route normalization for span attributes / metric labels.
 *
 * The Discord API uses snowflake IDs (17–20 digits) inside path segments
 * — `/channels/123456789012345678/messages/987654321098765432`. Sending
 * those raw to a tracing backend produces high-cardinality routes that
 * overflow per-route metric series and leak guild/channel/user IDs to
 * operators viewing traces.
 *
 * `redactRoute` collapses snowflakes to the literal `:id` so dashboards
 * can group by route shape. The `@me` literal (used in
 * `/users/@me/...`) and the `@original` literal (interactions edge case)
 * are preserved verbatim; both are stable route segments, not IDs.
 *
 * Query strings are stripped — they contain pagination cursors and
 * limits that are operationally interesting but bloat the cardinality
 * the same way IDs do. Surface them as separate span attributes when
 * needed, not via the route key.
 *
 * @example
 *   redactRoute('/channels/123456789012345678/messages/987654321098765432')
 *   // → '/channels/:id/messages/:id'
 *
 *   redactRoute('/users/@me/guilds/111122223333444455')
 *   // → '/users/@me/guilds/:id'
 *
 *   redactRoute('/guilds/111/regions?limit=10')
 *   // → '/guilds/:id/regions'
 *
 * Two Discord routes carry a **credential** in the path rather than an ID:
 * `/webhooks/{id}/{token}` and `/interactions/{id}/{token}`. Those tokens are
 * bearer credentials — anyone holding one can execute the webhook or respond
 * to the interaction without the bot token. They are not snowflakes, so the
 * digit-only rule above leaves them intact. They are collapsed positionally.
 *
 * @example
 *   redactRoute('/webhooks/123456789012345678/A_SECRET_TOKEN/messages/@original')
 *   // → '/webhooks/:id/:token/messages/@original'
 */
export function redactRoute(path: string): string {
  // Strip query string first; everything after `?` is operator-tunable
  // and should not be part of the route key.
  const queryIdx = path.indexOf('?');
  const withoutQuery = queryIdx >= 0 ? path.slice(0, queryIdx) : path;

  // Replace any sequence of 17–20 digits (Discord snowflake range) with
  // `:id`. We do NOT touch `@me` / `@original` because they have no
  // digits and the regex is digit-only by construction.
  const idsCollapsed = withoutQuery.replace(/\d{17,20}/g, ':id');

  // Collapse the credential segment positionally — by where it sits in the
  // route, not by what it looks like. A webhook token has no fixed character
  // class, so any pattern-based rule would miss some of them.
  const segs = idsCollapsed.split('/');
  for (let i = 0; i < segs.length; i++) {
    if ((segs[i] === 'webhooks' || segs[i] === 'interactions') && segs[i + 1] === ':id') {
      if (segs[i + 2] !== undefined && segs[i + 2] !== '') {
        segs[i + 2] = ':token';
      }
    }
  }
  return segs.join('/');
}

/**
 * Scrub Discord bearer credentials out of a free-text string (an error
 * message, a stack frame, a URL).
 *
 * `redactRoute` is for a known-clean path with a known shape. This is for text
 * that merely *contains* a URL — `DiscordAPIError.message`, `err.url`, an
 * exception thrown by fetch. It targets the two path-embedded credentials and
 * strips query strings, which is where Discord puts CDN signatures.
 */
export function redactCredentialUrl(text: string): string {
  return text
    .replace(/\/(webhooks|interactions)\/(\d{17,20})\/[^/?#\s]+/g, '/$1/$2/:token')
    .replace(/\?[^\s]*/g, '');
}
