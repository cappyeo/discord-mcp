import { createHash } from 'node:crypto';
import { REST } from '@discordjs/rest';
import { z } from 'zod';

const MAX_CACHE_ENTRIES = 1_024;

const Snowflake = z.string().regex(/^\d{17,20}$/u);

/**
 * `/oauth2/@me` documents `user` only for tokens carrying `identify`; without
 * it the response cannot be attributed to a person, so the call is refused.
 */
const AuthorizationSchema = z.object({
  application: z.object({ id: Snowflake }),
  scopes: z.array(z.string()),
  expires: z.string(),
  user: z.object({ id: Snowflake, username: z.string().optional() }).optional(),
});

/**
 * A Discord user token that is structurally valid but not allowed to drive
 * this deployment. 401 means Discord rejected the credential; 403 means the
 * token is real but the caller is not authorized here.
 */
export class OAuthCallerRejected extends Error {
  public constructor(
    public readonly status: 401 | 403,
    message: string,
  ) {
    super(message);
  }
}

/** The HTTP seam `@discordjs/rest` accepts as `makeRequest`. */
export type DiscordHttp = Required<
  NonNullable<ConstructorParameters<typeof REST>[0]>
>['makeRequest'];

export interface OAuthCaller {
  readonly id: string;
  readonly username: string | null;
}

export interface OAuthCallerVerifierOptions {
  /**
   * This deployment's application ID. `/oauth2/@me` reports the application a
   * token was issued to, and accepting any application's token would let an
   * unrelated app's consent drive this bot.
   */
  readonly expectedBotId?: string;
  /**
   * HTTP implementation used for verification. Real deployments use the
   * default; suites point it at a loopback Discord stub.
   */
  readonly makeRequest?: DiscordHttp;
  /** Test seam for the user-token REST client (overrides `makeRequest`). */
  readonly restForToken?: (token: string) => REST;
  /** Test seam for the cache clock. */
  readonly now?: () => number;
}

/**
 * Verify a Discord OAuth2 user access token against `/oauth2/@me` and resolve
 * the Discord user it belongs to. Successful verifications are cached until the
 * token's own expiry, so a stateless HTTP server calls Discord once per token.
 */
export function createOAuthCallerVerifier(
  options: OAuthCallerVerifierOptions,
): (token: string) => Promise<OAuthCaller> {
  const cache = new Map<string, { readonly expiresAt: number; readonly caller: OAuthCaller }>();
  const now = options.now ?? Date.now;
  const makeRequest = options.makeRequest;
  const restForToken =
    options.restForToken ??
    ((token: string): REST =>
      new REST({
        version: '10',
        authPrefix: 'Bearer',
        retries: 0,
        rejectOnRateLimit: () => true,
        ...(makeRequest === undefined ? {} : { makeRequest }),
      }).setToken(token));

  return async (token: string): Promise<OAuthCaller> => {
    const key = createHash('sha256').update(token).digest('base64url');
    const hit = cache.get(key);
    if (hit !== undefined) {
      if (hit.expiresAt > now()) return hit.caller;
      cache.delete(key);
    }

    let raw: unknown;
    try {
      raw = await restForToken(token).get('/oauth2/@me' as `/${string}`);
    } catch {
      throw new OAuthCallerRejected(401, 'Discord rejected the OAuth2 access token');
    }
    const parsed = AuthorizationSchema.safeParse(raw);
    if (!parsed.success) {
      throw new OAuthCallerRejected(401, 'Discord returned a malformed authorization');
    }
    const authorization = parsed.data;
    const expiresAt = Date.parse(authorization.expires);
    if (!Number.isFinite(expiresAt) || expiresAt <= now()) {
      throw new OAuthCallerRejected(401, 'The OAuth2 access token has expired');
    }
    if (!authorization.scopes.includes('identify')) {
      throw new OAuthCallerRejected(403, 'The OAuth2 token is missing the identify scope');
    }
    if (
      options.expectedBotId !== undefined &&
      authorization.application.id !== options.expectedBotId
    ) {
      throw new OAuthCallerRejected(403, 'The OAuth2 token belongs to a different application');
    }
    if (authorization.user === undefined) {
      throw new OAuthCallerRejected(403, 'The OAuth2 token does not identify a Discord user');
    }

    const caller: OAuthCaller = {
      id: authorization.user.id,
      username: authorization.user.username ?? null,
    };
    if (cache.size >= MAX_CACHE_ENTRIES) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(key, { expiresAt, caller });
    return caller;
  };
}
