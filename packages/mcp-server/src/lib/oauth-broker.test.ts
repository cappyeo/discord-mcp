import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DiscordOAuthBroker, OAuthBrokerError } from './oauth-broker.js';
import type { DiscordHttp } from './oauth2.js';

const CLIENT_ID = '1566823844801548491';
const CLIENT_SECRET = 'client-secret-value-with-enough-length';
const USER_ID = '111122223333444455';
const PUBLIC_URL = new URL('https://mcp.example.test');
const MCP_REDIRECT = 'https://client.example.test/callback';
const NOW = Date.parse('2026-11-02T00:00:00.000Z');

const verifier = 'verifier-abcdefghijklmnopqrstuvwxyz-0123456789';
const challenge = createHash('sha256').update(verifier).digest('base64url');

/** Discord stub: one code → one user token → identity bound to CLIENT_ID. */
function discordStub(overrides: { readonly fails?: boolean } = {}): {
  fetch: DiscordHttp;
  calls: string[];
} {
  const calls: string[] = [];
  const fetchImpl = (async (url: string) => {
    calls.push(url);
    if (overrides.fails === true) {
      return new Response('nope', { status: 401 }) as unknown as never;
    }
    if (url.includes('/oauth2/token')) {
      return new Response(
        JSON.stringify({ access_token: 'discord-user-token', token_type: 'Bearer' }),
        { status: 200 },
      ) as unknown as never;
    }
    return new Response(JSON.stringify({ application: { id: CLIENT_ID }, user: { id: USER_ID } }), {
      status: 200,
    }) as unknown as never;
  }) as unknown as DiscordHttp;
  return { fetch: fetchImpl, calls };
}

function broker(options: { fails?: boolean; now?: () => number } = {}): {
  broker: DiscordOAuthBroker;
  calls: string[];
} {
  const stub = discordStub(options.fails === undefined ? {} : { fails: options.fails });
  return {
    broker: new DiscordOAuthBroker({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      publicUrl: PUBLIC_URL,
      makeRequest: stub.fetch,
      now: options.now ?? (() => NOW),
    }),
    calls: stub.calls,
  };
}

function authorizeParams(clientId = 'mcp-client'): URLSearchParams {
  return new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: MCP_REDIRECT,
    state: 'client-state',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    scope: 'identify',
  });
}

/** Drive one full login, returning the broker code handed to the client. */
async function login(instance: DiscordOAuthBroker): Promise<string> {
  const authorizeUrl = instance.authorizeUrl(authorizeParams());
  const loginId = authorizeUrl.searchParams.get('state')!;
  const redirect = await instance.callback(new URLSearchParams({ state: loginId, code: 'dc' }));
  return redirect.searchParams.get('code')!;
}

describe('Discord OAuth2 broker', () => {
  it('registers a public client with its redirect URIs', () => {
    const { broker: instance } = broker();
    const registration = instance.register({ redirect_uris: [MCP_REDIRECT] });
    expect(registration).toMatchObject({
      redirect_uris: [MCP_REDIRECT],
      token_endpoint_auth_method: 'none',
      response_types: ['code'],
    });
    expect(String(registration.client_id)).toMatch(/^mcp-/);
  });

  it('rejects registration without usable redirect URIs', () => {
    const { broker: instance } = broker();
    expect(() => instance.register({})).toThrow(OAuthBrokerError);
    expect(() => instance.register({ redirect_uris: ['not a url'] })).toThrow(/redirect_uris/);
  });

  it('sends the user to Discord with the required scopes and its own callback', () => {
    const { broker: instance } = broker();
    const url = instance.authorizeUrl(authorizeParams());
    expect(url.origin).toBe('https://discord.com');
    expect(url.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(url.searchParams.get('scope')).toContain('identify');
    expect(url.searchParams.get('redirect_uri')).toBe('https://mcp.example.test/oauth/callback');
    // The Discord leg carries a broker-generated CSRF token, not the client's.
    expect(url.searchParams.get('state')).not.toBe('client-state');
  });

  it('requires PKCE S256 and the code response type', () => {
    const { broker: instance } = broker();
    // Missing PKCE is reported as its own error, not a generic bad request.
    expect(() =>
      instance.authorizeUrl(
        new URLSearchParams({ client_id: 'c', redirect_uri: MCP_REDIRECT, state: 's' }),
      ),
    ).toThrow(/code_challenge/);
    const plain = authorizeParams();
    plain.delete('code_challenge_method');
    expect(() => instance.authorizeUrl(plain)).toThrow(/S256/);
    const implicit = authorizeParams();
    implicit.set('response_type', 'token');
    expect(() => instance.authorizeUrl(implicit)).toThrow(/only code is supported/);
  });

  it('completes the exchange and issues a broker token bound to the Discord user', async () => {
    const { broker: instance, calls } = broker();
    const code = await login(instance);
    const tokens = await instance.token(
      new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
      }),
    );
    expect(tokens).toMatchObject({ token_type: 'Bearer', scope: 'identify' });
    expect(instance.principalFor(String(tokens.access_token))).toBe(USER_ID);
    // Both legs reach Discord: code exchange, then identity.
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain('/oauth2/token');
    expect(calls[1]).toContain('/oauth2/@me');
  });

  it('refuses a code replayed with the wrong PKCE verifier', async () => {
    const { broker: instance } = broker();
    const code = await login(instance);
    await expect(
      instance.token(
        new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          code_verifier: 'wrong-verifier',
        }),
      ),
    ).rejects.toMatchObject({ error: 'invalid_grant' });
  });

  it('consumes a code exactly once', async () => {
    const { broker: instance } = broker();
    const code = await login(instance);
    const exchange = (): Promise<Record<string, unknown>> =>
      instance.token(
        new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          code_verifier: verifier,
        }),
      );
    await expect(exchange()).resolves.toMatchObject({ token_type: 'Bearer' });
    await expect(exchange()).rejects.toMatchObject({ error: 'invalid_grant' });
  });

  it('refuses a replayed login callback', async () => {
    const { broker: instance, calls } = broker();
    const loginId = instance.authorizeUrl(authorizeParams()).searchParams.get('state')!;
    await instance.callback(new URLSearchParams({ state: loginId, code: 'dc' }));
    await expect(
      instance.callback(new URLSearchParams({ state: loginId, code: 'dc' })),
    ).rejects.toMatchObject({ error: 'invalid_request' });
    // The Discord exchange ran once, not twice.
    expect(calls.filter((call) => call.includes('/oauth2/token'))).toHaveLength(1);
  });

  it('surfaces Discord rejecting the code as an authorization failure', async () => {
    const { broker: instance } = broker({ fails: true });
    const loginId = instance.authorizeUrl(authorizeParams()).searchParams.get('state')!;
    await expect(
      instance.callback(new URLSearchParams({ state: loginId, code: 'dc' })),
    ).rejects.toMatchObject({ status: 401 });
  });

  it('expires broker tokens', async () => {
    let now = NOW;
    const { broker: instance } = broker({ now: () => now });
    const code = await login(instance);
    const tokens = await instance.token(
      new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: verifier }),
    );
    const token = String(tokens.access_token);
    expect(instance.principalFor(token)).toBe(USER_ID);
    // Still valid just under Discord's own 7-day token window.
    now = NOW + 7 * 24 * 3_600_000 - 1_000;
    expect(instance.principalFor(token)).toBe(USER_ID);

    now = NOW + 7 * 24 * 3_600_000 + 1_000;
    expect(instance.principalFor(token)).toBeUndefined();
  });

  it('advertises the same lifetime it enforces', async () => {
    const { broker: instance } = broker();
    const code = await login(instance);
    const tokens = await instance.token(
      new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: verifier }),
    );
    expect(tokens.expires_in).toBe(7 * 24 * 3_600);
  });

  it('does not expose expired pending logins', async () => {
    let now = NOW;
    const { broker: instance } = broker({ now: () => now });
    const loginId = instance.authorizeUrl(authorizeParams()).searchParams.get('state')!;
    now = NOW + 601_000;
    await expect(
      instance.callback(new URLSearchParams({ state: loginId, code: 'dc' })),
    ).rejects.toMatchObject({ error: 'invalid_request' });
  });
});
