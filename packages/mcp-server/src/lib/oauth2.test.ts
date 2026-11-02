import type { REST } from '@discordjs/rest';
import { describe, expect, it, type Mock, vi } from 'vitest';
import { createOAuthCallerVerifier, type OAuthCaller, OAuthCallerRejected } from './oauth2.js';

const USER_ID = '111122223333444455';
const OTHER_USER_ID = '222233334444555566';
const BOT_ID = '987654321098765432';
const TOKEN = 'user-access-token-value';
const NOW = Date.parse('2026-11-02T00:00:00.000Z');

function verifier(
  authorization: unknown,
  options: {
    applicationId?: string;
    now?: () => number;
    rejects?: boolean;
  } = {},
): { verify: (token: string) => Promise<OAuthCaller>; get: Mock } {
  const get = vi.fn(async () => {
    if (options.rejects === true) throw new Error('Discord said 401');
    return authorization;
  });
  const verify = createOAuthCallerVerifier({
    applicationId: options.applicationId ?? BOT_ID,
    restForToken: () => ({ get }) as unknown as REST,
    now: options.now ?? (() => NOW),
  });
  return { verify, get };
}

function authorization(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    application: { id: BOT_ID },
    scopes: ['identify', 'guilds'],
    expires: '2026-11-09T00:00:00.000Z',
    user: { id: USER_ID, username: 'caller' },
    ...overrides,
  };
}

describe('OAuth2 caller verification', () => {
  it('resolves the Discord user a valid token belongs to', async () => {
    const { verify } = verifier(authorization());
    await expect(verify(TOKEN)).resolves.toEqual({ id: USER_ID, username: 'caller' });
  });

  it('rejects tokens Discord refuses as 401', async () => {
    const { verify } = verifier(authorization(), { rejects: true });
    await expect(verify(TOKEN)).rejects.toMatchObject({ status: 401 });
  });

  it('rejects malformed authorization responses', async () => {
    const { verify } = verifier({ scopes: ['identify'] });
    await expect(verify(TOKEN)).rejects.toBeInstanceOf(OAuthCallerRejected);
  });

  it('requires the identify scope so the caller can be attributed', async () => {
    const { verify } = verifier(authorization({ scopes: ['guilds'] }));
    await expect(verify(TOKEN)).rejects.toMatchObject({ status: 403 });

    const unattributed = verifier(authorization({ user: undefined }));
    await expect(unattributed.verify(TOKEN)).rejects.toMatchObject({ status: 403 });
  });

  it('rejects expired tokens instead of trusting Discord alone', async () => {
    const { verify } = verifier(authorization({ expires: '2026-11-01T23:59:59.000Z' }));
    await expect(verify(TOKEN)).rejects.toMatchObject({ status: 401 });

    const unparseable = verifier(authorization({ expires: 'never' }));
    await expect(unparseable.verify(TOKEN)).rejects.toMatchObject({ status: 401 });
  });

  it('rejects a token issued to a different application', async () => {
    const { verify } = verifier(authorization());
    await expect(verify(TOKEN)).resolves.toMatchObject({ id: USER_ID });

    const foreign = verifier(authorization({ application: { id: OTHER_USER_ID } }));
    await expect(foreign.verify(TOKEN)).rejects.toMatchObject({ status: 403 });
  });

  it('accepts any Discord user, leaving authorization to their own permissions', async () => {
    const { verify } = verifier(
      authorization({ user: { id: OTHER_USER_ID, username: 'someone-else' } }),
    );
    await expect(verify(TOKEN)).resolves.toEqual({ id: OTHER_USER_ID, username: 'someone-else' });
  });

  it('caches a verified token until its own expiry', async () => {
    let now = NOW;
    const { verify, get } = verifier(authorization(), { now: () => now });

    await verify(TOKEN);
    await verify(TOKEN);
    expect(get).toHaveBeenCalledTimes(1);

    now = Date.parse('2026-11-09T00:00:01.000Z');
    await expect(verify(TOKEN)).rejects.toMatchObject({ status: 401 });
    expect(get).toHaveBeenCalledTimes(2);
  });
});
