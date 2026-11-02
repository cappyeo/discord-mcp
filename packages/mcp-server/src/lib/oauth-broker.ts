import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { GrantStore } from './oauth-grant-store.js';
import { MemoryGrantStore } from './oauth-grant-store.js';
import { type DiscordHttp, OAuthCallerRejected } from './oauth2.js';

/**
 * Discord's authorization-code exchange requires client authentication
 * (`client_secret_basic` or `-post`); PKCE alone is not accepted. This broker
 * therefore holds the application secret and does the exchange server-side,
 * issuing its own access token to the MCP client.
 */
const DISCORD_TOKEN_URL = 'https://discord.com/api/oauth2/token';
const DISCORD_AUTHORIZE_URL = 'https://discord.com/oauth2/authorize';
const DISCORD_SCOPES = ['identify', 'guilds', 'guilds.members.read'] as const;

/** Access token lifetime handed to MCP clients. */
const ACCESS_TOKEN_TTL_SECONDS = 3_600;
const PENDING_LOGIN_TTL_SECONDS = 600;
const MAX_PENDING_LOGINS = 1_024;

export interface BrokerOptions {
  readonly clientId: string;
  readonly clientSecret: string;
  /** Public origin of this deployment, e.g. https://discord-mcp.example.org */
  readonly publicUrl: URL;
  /** Where issued tokens live. Defaults to a process-local map. */
  readonly grantStore?: GrantStore;
  /** HTTP seam for the Discord token exchange; suites point it at a stub. */
  readonly makeRequest?: DiscordHttp;
  /** Test seam for expiring entries. */
  readonly now?: () => number;
}

interface PendingLogin {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly state: string;
  /** The MCP client's PKCE challenge, replayed to it at /token. */
  readonly codeChallenge: string;
  readonly scope: string | undefined;
  readonly expiresAt: number;
  /** Discord user bound to an issued broker code; absent on initial logins. */
  readonly userId?: string;
}

interface RawTokenResponse {
  readonly access_token?: unknown;
  readonly token_type?: unknown;
  readonly expires_in?: unknown;
  readonly scope?: unknown;
  readonly refresh_token?: unknown;
}

function sha256(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

/** Whether a presented `code_verifier` matches the challenge the client sent. */
function pkceMatches(verifier: string, challenge: string): boolean {
  const computed = sha256(verifier).toString('base64url');
  const left = Buffer.from(computed);
  const right = Buffer.from(challenge);
  return left.length === right.length && timingSafeEqual(left, right);
}

export class OAuthBrokerError extends Error {
  public constructor(
    public readonly status: 400 | 401,
    public readonly error: string,
    description: string,
  ) {
    super(description);
  }
}

/**
 * Minimal OAuth 2.1 authorization server for MCP clients whose user identity
 * comes from Discord.
 *
 * The MCP client registers here, is redirected to Discord for consent, and
 * returns to `/oauth/callback`; the broker exchanges Discord's code for a user
 * token, records the resulting Discord user, and issues its own token pairwise
 * to that client. Only the Discord user ID is retained — Discord's user tokens
 * are discarded once the identity is read.
 */
export class DiscordOAuthBroker {
  private readonly pending = new Map<string, PendingLogin>();
  private readonly grantStore: GrantStore;
  private readonly now: () => number;

  public constructor(private readonly options: BrokerOptions) {
    this.now = options.now ?? Date.now;
    this.grantStore = options.grantStore ?? new MemoryGrantStore(this.now);
  }

  /**
   * RFC 7591 dynamic client registration. The client is public: it holds no
   * secret, and PKCE binds the code to whoever completes the exchange.
   */
  public register(body: unknown): Record<string, unknown> {
    const metadata = body !== null && typeof body === 'object' ? body : {};
    const redirectUris = (metadata as { redirect_uris?: unknown }).redirect_uris;
    if (!Array.isArray(redirectUris) || redirectUris.length === 0) {
      throw new OAuthBrokerError(400, 'invalid_client_metadata', 'redirect_uris is required');
    }
    for (const uri of redirectUris) {
      if (typeof uri !== 'string' || !URL.canParse(uri)) {
        throw new OAuthBrokerError(400, 'invalid_redirect_uri', 'redirect_uris must be URLs');
      }
    }
    // Registration is stateless: the client ID *is* its metadata, so a broker
    // restart or a second replica does not invalidate a registered client.
    const issuedAt = Math.floor(this.now() / 1_000);
    return {
      client_id: `mcp-${issuedAt}-${randomBytes(12).toString('base64url')}`,
      client_id_issued_at: issuedAt,
      redirect_uris: redirectUris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
  }

  /** Begin a login by redirecting the user agent to Discord's consent screen. */
  public authorizeUrl(params: URLSearchParams): URL {
    const clientId = params.get('client_id');
    const redirectUri = params.get('redirect_uri');
    const state = params.get('state');
    const codeChallenge = params.get('code_challenge');
    if (clientId === null || redirectUri === null || state === null) {
      throw new OAuthBrokerError(400, 'invalid_request', 'client_id, redirect_uri, state required');
    }
    if (codeChallenge === null) {
      throw new OAuthBrokerError(400, 'invalid_request', 'PKCE S256 code_challenge is required');
    }
    if (params.get('code_challenge_method') !== 'S256') {
      throw new OAuthBrokerError(400, 'invalid_request', 'only S256 PKCE is supported');
    }
    if (params.get('response_type') !== 'code') {
      throw new OAuthBrokerError(400, 'unsupported_response_type', 'only code is supported');
    }

    // The login ID is the CSRF token for the Discord leg; it is generated
    // here, never taken from the request.
    const loginId = randomBytes(32).toString('base64url');
    this.evictExpired();
    this.pending.set(loginId, {
      clientId,
      redirectUri,
      state,
      codeChallenge,
      scope: params.get('scope') ?? undefined,
      expiresAt: this.now() + PENDING_LOGIN_TTL_SECONDS * 1_000,
    });

    const url = new URL(DISCORD_AUTHORIZE_URL);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', this.options.clientId);
    url.searchParams.set('scope', DISCORD_SCOPES.join(' '));
    url.searchParams.set('redirect_uri', this.callbackUrl());
    url.searchParams.set('state', loginId);
    return url;
  }

  public callbackUrl(): string {
    return new URL('/oauth/callback', this.options.publicUrl).toString();
  }

  /**
   * Complete the Discord leg: exchange its code, read the Discord user, and
   * redirect the user agent back to the MCP client with a broker code.
   */
  public async callback(params: URLSearchParams): Promise<URL> {
    const loginId = params.get('state');
    if (loginId === null) throw new OAuthBrokerError(400, 'invalid_request', 'state is required');
    const login = this.pending.get(loginId);
    // Single use: consume before any await so a replayed callback cannot
    // complete the same login twice.
    this.pending.delete(loginId);
    if (login === undefined || login.expiresAt <= this.now()) {
      throw new OAuthBrokerError(400, 'invalid_request', 'unknown or expired login');
    }
    const discordCode = params.get('code');
    if (discordCode === null) {
      throw new OAuthBrokerError(400, 'access_denied', 'Discord did not return a code');
    }

    const user = await this.exchangeDiscordCode(discordCode, login);
    const code = randomBytes(32).toString('base64url');
    this.pending.set(`code:${code}`, {
      ...login,
      userId: user.id,
      expiresAt: this.now() + PENDING_LOGIN_TTL_SECONDS * 1_000,
    });

    const redirect = new URL(login.redirectUri);
    redirect.searchParams.set('code', code);
    redirect.searchParams.set('state', login.state);
    return redirect;
  }

  private async exchangeDiscordCode(code: string, login: PendingLogin): Promise<{ id: string }> {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.callbackUrl(),
    });
    const response = await this.discordFetch(`${DISCORD_TOKEN_URL}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: `Basic ${Buffer.from(
          `${this.options.clientId}:${this.options.clientSecret}`,
        ).toString('base64')}`,
      },
      body,
    });
    if (!response.ok) {
      throw new OAuthCallerRejected(401, 'Discord rejected the authorization code');
    }
    const raw = (await response.json()) as RawTokenResponse;
    if (typeof raw.access_token !== 'string') {
      throw new OAuthCallerRejected(401, 'Discord returned a malformed token response');
    }
    // Identity is resolved from the token exactly as the shared-token path
    // does; the Discord token itself is never stored.
    const identity = await this.discordFetch('https://discord.com/api/v10/oauth2/@me', {
      headers: { authorization: `Bearer ${raw.access_token}` },
    });
    if (!identity.ok) {
      throw new OAuthCallerRejected(401, 'Discord rejected the user access token');
    }
    const me = (await identity.json()) as {
      user?: { id?: unknown };
      application?: { id?: unknown };
    };
    if (typeof me.user?.id !== 'string') {
      throw new OAuthCallerRejected(403, 'The OAuth2 token does not identify a Discord user');
    }
    if (me.application?.id !== this.options.clientId) {
      throw new OAuthCallerRejected(403, 'The OAuth2 token belongs to a different application');
    }
    return { id: me.user.id };
  }

  /** Exchange a broker code for a broker access token, verifying PKCE. */
  public async token(body: URLSearchParams): Promise<Record<string, unknown>> {
    if (body.get('grant_type') !== 'authorization_code') {
      throw new OAuthBrokerError(400, 'unsupported_grant_type', 'only authorization_code');
    }
    const code = body.get('code');
    const verifier = body.get('code_verifier');
    if (code === null || verifier === null) {
      throw new OAuthBrokerError(400, 'invalid_request', 'code and code_verifier are required');
    }
    const pending = this.pending.get(`code:${code}`);
    this.pending.delete(`code:${code}`);
    if (pending === undefined || pending.expiresAt <= this.now()) {
      throw new OAuthBrokerError(400, 'invalid_grant', 'unknown or expired code');
    }
    if (!pkceMatches(verifier, pending.codeChallenge)) {
      throw new OAuthBrokerError(400, 'invalid_grant', 'PKCE verification failed');
    }

    const accessToken = randomBytes(32).toString('base64url');
    const scope = pending.scope ?? DISCORD_SCOPES.join(' ');
    if (pending.userId === undefined) {
      throw new OAuthBrokerError(400, 'invalid_grant', 'code is not bound to a Discord user');
    }
    this.grantStore.set(accessToken, {
      userId: pending.userId,
      clientId: pending.clientId,
      scope,
      expiresAt: this.now() + ACCESS_TOKEN_TTL_SECONDS * 1_000,
    });
    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      scope,
    };
  }

  /** The Discord user behind an issued access token, or undefined when not valid. */
  public principalFor(token: string): string | undefined {
    return this.grantStore.get(token)?.userId;
  }

  private async discordFetch(url: string, init: RequestInit): Promise<Response> {
    const makeRequest = this.options.makeRequest;
    if (makeRequest === undefined) return fetch(url, init);
    return makeRequest(url, init as never) as unknown as Promise<Response>;
  }

  /** Bound the pending map so unauthenticated traffic cannot grow it. */
  private evictExpired(): void {
    if (this.pending.size < MAX_PENDING_LOGINS) return;
    const now = this.now();
    for (const [key, entry] of this.pending) {
      if (entry.expiresAt <= now) this.pending.delete(key);
    }
    while (this.pending.size >= MAX_PENDING_LOGINS) {
      const oldest = this.pending.keys().next().value;
      if (oldest === undefined) break;
      this.pending.delete(oldest);
    }
  }
}
