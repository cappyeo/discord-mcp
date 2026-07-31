/**
 * `token-online` check — Plan 9 Phase C.
 *
 * Verifies the configured DISCORD_TOKEN against the live Discord REST API
 * by hitting `GET /users/@me`. This is the only check that proves the
 * token is *currently valid* and the bot account is reachable; the offline
 * `token-format` check only verifies shape.
 *
 * Privacy: the token NEVER appears in `details` or `message`. We only
 * surface the resolved bot identity (username, id, bot flag) on success
 * and HTTP status / error message on failure.
 *
 * Test-only escape hatch: `DISCORD_API_BASE_URL` env override. Defaults
 * to `https://discord.com/api/v10`. Integration tests set this to a
 * loopback `node:http` server (see doctor.integration.test.ts). NEVER
 * documented in user-facing help — it exists purely to avoid pulling in
 * `nock` / `msw` for ONLINE network tests.
 *
 * Timeout: 5 seconds via AbortController. On abort we report 'warn'
 * (treating the result as inconclusive rather than failed) so transient
 * network issues don't block the user from running their MCP server.
 */
import type { DoctorCheck } from './index.js';

const DISCORD_API_BASE = process.env.DISCORD_API_BASE_URL ?? 'https://discord.com/api/v10';
const REQUEST_TIMEOUT_MS = 5000;

/**
 * Discord requires an exact `Authorization: Bot <token>` header. The
 * config schema accepts either bare tokens or `Bot `-prefixed ones; we
 * normalize by stripping any leading `Bot ` and re-adding it ourselves.
 */
function authHeader(token: string): string {
  const stripped = token.startsWith('Bot ') ? token.slice(4) : token;
  return `Bot ${stripped}`;
}

interface DiscordUserResponse {
  readonly id?: string;
  readonly username?: string;
  readonly bot?: boolean;
}

export const tokenOnlineCheck: DoctorCheck = {
  id: 'token-online',
  description: 'Discord token verification (live)',
  online: true,
  async run(config) {
    if (config === null) {
      return {
        id: 'token-online',
        status: 'warn',
        message: 'cannot verify — config invalid',
      };
    }

    const url = `${DISCORD_API_BASE}/users/@me`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);

    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: {
          Authorization: authHeader(config.DISCORD_TOKEN),
          'User-Agent': 'discord-mcp-doctor (https://github.com/cappyeo/discord-mcp)',
        },
        signal: ctrl.signal,
      });

      if (res.status === 200) {
        // Parse defensively — a 200 with malformed body still implies the
        // token is accepted, so we degrade gracefully if JSON parse fails.
        let data: DiscordUserResponse = {};
        try {
          data = (await res.json()) as DiscordUserResponse;
        } catch {
          // Empty / non-JSON 200 is acceptable; surface what we can.
        }
        return {
          id: 'token-online',
          status: 'ok',
          message: data.username
            ? `Discord accepted token for ${data.username}`
            : 'Discord accepted token',
          details: {
            username: data.username ?? null,
            id: data.id ?? null,
            bot: data.bot ?? false,
          },
        };
      }

      if (res.status === 401) {
        return {
          id: 'token-online',
          status: 'fail',
          message: 'token invalid (401)',
          details: { status: 401 },
        };
      }

      if (res.status === 403) {
        return {
          id: 'token-online',
          status: 'fail',
          message: 'token disabled or bot kicked (403)',
          details: { status: 403 },
        };
      }

      if (res.status === 429) {
        const retryAfter = parseInt(res.headers.get('retry-after') ?? '0', 10);
        return {
          id: 'token-online',
          status: 'warn',
          message: 'rate-limited; cannot verify right now',
          details: { status: 429, retry_after_seconds: retryAfter },
        };
      }

      return {
        id: 'token-online',
        status: 'warn',
        message: `unexpected response from Discord: ${res.status}`,
        details: { status: res.status },
      };
    } catch (e) {
      // AbortError (timeout) and network errors (DNS, ECONNREFUSED, etc.)
      // both surface as 'warn' — the doctor user can still proceed offline.
      const message = e instanceof Error ? e.message : String(e);
      return {
        id: 'token-online',
        status: 'warn',
        message: `offline or unreachable: ${message}`,
      };
    } finally {
      clearTimeout(timer);
    }
  },
};
