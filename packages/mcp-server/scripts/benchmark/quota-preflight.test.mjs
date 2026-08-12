import { describe, expect, it, vi } from 'vitest';

import { BenchmarkQuotaPreflightError, probeGuildRoleCreateQuota } from './quota-preflight.mjs';

const GUILD_ID = '1533989004406558851';
const BOT_ID = '1533457669384306858';
const ROLE_ID = '1533989004406558859';
const OTHER_ROLE_ID = '1533989004406558860';
const FINGERPRINT = `sha256:${'a'.repeat(64)}`;

function temporaryRole(id = ROLE_ID) {
  return {
    id,
    name: `__discord_mcp_quota_preflight_probe_${GUILD_ID}`,
    permissions: '0',
    hoist: false,
    mentionable: false,
    managed: false,
  };
}

function baseline() {
  return { guild_id: GUILD_ID, bot_id: BOT_ID, fingerprint: FINGERPRINT };
}

function verifier() {
  const calls = [];
  return {
    calls,
    verifyBaseline: vi.fn(async ({ baseline: value, guildId, botId }) => {
      calls.push({ baseline: value, guildId, botId });
      return { verified: true, guild_id: guildId, bot_id: botId, fingerprint: FINGERPRINT };
    }),
  };
}

describe('guild role-create quota preflight', () => {
  it('creates a zero-permission temporary role with the exact target and deletes it', async () => {
    const verify = verifier();
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        ...temporaryRole(),
        name: `__discord_mcp_quota_preflight_test-run_${GUILD_ID}`,
      })
      .mockResolvedValueOnce(null);

    const result = await probeGuildRoleCreateQuota({
      rest: { request },
      verifyBaseline: verify.verifyBaseline,
      baseline: baseline(),
      guildId: GUILD_ID,
      botId: BOT_ID,
      runId: 'test-run',
    });

    expect(result).toEqual({
      schema_version: 'discord-mcp.benchmark-quota-preflight.v1',
      guild_id: GUILD_ID,
      bot_id: BOT_ID,
      status: 'ready',
      create_attempts: 1,
      waited_ms: 0,
      retry_after_ms: null,
      role_id: ROLE_ID,
      baseline_fingerprint_before: FINGERPRINT,
      baseline_fingerprint_after: FINGERPRINT,
      baseline_restored: true,
    });
    expect(request).toHaveBeenNthCalledWith(1, 'POST', `/guilds/${GUILD_ID}/roles`, {
      body: {
        name: `__discord_mcp_quota_preflight_test-run_${GUILD_ID}`,
        permissions: '0',
        hoist: false,
        mentionable: false,
      },
      reason: 'discord-mcp benchmark quota preflight test-run',
      retry: false,
    });
    expect(request).toHaveBeenNthCalledWith(2, 'DELETE', `/guilds/${GUILD_ID}/roles/${ROLE_ID}`, {
      reason: 'discord-mcp benchmark quota preflight test-run',
      retry: true,
    });
    expect(verify.verifyBaseline).toHaveBeenCalledTimes(2);
  });

  it('returns exact unaffordable Retry-After evidence without retrying a 429 create', async () => {
    const verify = verifier();
    const sleep = vi.fn(async () => undefined);
    const request = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error('rate limited'), { status: 429, retryAfterMs: 172_207_050 }),
      );

    const result = await probeGuildRoleCreateQuota({
      rest: { request },
      verifyBaseline: verify.verifyBaseline,
      baseline: baseline(),
      guildId: GUILD_ID,
      botId: BOT_ID,
      sleep,
    });

    expect(result.status).toBe('unavailable');
    expect(result.waited_ms).toBe(0);
    expect(result.retry_after_ms).toBe(172_207_050);
    expect(result.role_id).toBeNull();
    expect(result.baseline_restored).toBe(true);
    expect(request).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
    expect(verify.verifyBaseline).toHaveBeenCalledTimes(2);
  });

  it('waits one exact affordable 429 window before proving role-create readiness', async () => {
    const verify = verifier();
    const sleep = vi.fn(async () => undefined);
    const request = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error('rate limited'), { status: 429, retryAfterMs: 53_037 }),
      )
      .mockResolvedValueOnce(temporaryRole())
      .mockResolvedValueOnce(null);

    const result = await probeGuildRoleCreateQuota({
      rest: { request },
      verifyBaseline: verify.verifyBaseline,
      baseline: baseline(),
      guildId: GUILD_ID,
      botId: BOT_ID,
      sleep,
    });

    expect(result.status).toBe('ready');
    expect(result.create_attempts).toBe(2);
    expect(result.waited_ms).toBe(53_037);
    expect(sleep).toHaveBeenCalledExactlyOnceWith(53_037);
    expect(request).toHaveBeenCalledTimes(3);
    expect(verify.verifyBaseline).toHaveBeenCalledTimes(3);
  });

  it('never waits or attempts a third create after a second affordable 429', async () => {
    const verify = verifier();
    const sleep = vi.fn(async () => undefined);
    const request = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error('rate limited'), { status: 429, retryAfterMs: 53_037 }),
      );

    const result = await probeGuildRoleCreateQuota({
      rest: { request },
      verifyBaseline: verify.verifyBaseline,
      baseline: baseline(),
      guildId: GUILD_ID,
      botId: BOT_ID,
      sleep,
    });

    expect(result.status).toBe('unavailable');
    expect(result.create_attempts).toBe(2);
    expect(result.waited_ms).toBe(53_037);
    expect(result.retry_after_ms).toBe(53_037);
    expect(sleep).toHaveBeenCalledExactlyOnceWith(53_037);
    expect(request).toHaveBeenCalledTimes(2);
    expect(verify.verifyBaseline).toHaveBeenCalledTimes(3);
  });

  it('does not create a role when the initial exact baseline verification fails', async () => {
    const verify = verifier();
    verify.verifyBaseline.mockRejectedValueOnce(new Error('baseline drift'));
    const request = vi.fn();

    await expect(
      probeGuildRoleCreateQuota({
        rest: { request },
        verifyBaseline: verify.verifyBaseline,
        baseline: baseline(),
        guildId: GUILD_ID,
        botId: BOT_ID,
      }),
    ).rejects.toMatchObject({ code: 'PREFLIGHT_BASELINE_VERIFICATION_FAILED' });
    expect(request).not.toHaveBeenCalled();
  });

  it('fails closed when baseline drifts after a 429 without retrying the create', async () => {
    const verify = verifier();
    verify.verifyBaseline
      .mockResolvedValueOnce({
        verified: true,
        guild_id: GUILD_ID,
        bot_id: BOT_ID,
        fingerprint: FINGERPRINT,
      })
      .mockRejectedValueOnce(new Error('baseline drift'));
    const request = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error('rate limited'), { status: 429, retryAfterMs: 53_037 }),
      );

    await expect(
      probeGuildRoleCreateQuota({
        rest: { request },
        verifyBaseline: verify.verifyBaseline,
        baseline: baseline(),
        guildId: GUILD_ID,
        botId: BOT_ID,
      }),
    ).rejects.toMatchObject({ code: 'PREFLIGHT_BASELINE_VERIFICATION_FAILED' });
    expect(request).toHaveBeenCalledOnce();
  });

  it('rejects a baseline target mismatch before any REST request', async () => {
    const verify = verifier();
    const request = vi.fn();

    await expect(
      probeGuildRoleCreateQuota({
        rest: { request },
        verifyBaseline: verify.verifyBaseline,
        baseline: { ...baseline(), guild_id: OTHER_ROLE_ID },
        guildId: GUILD_ID,
        botId: BOT_ID,
      }),
    ).rejects.toThrow('baseline guild_id does not match guildId');
    expect(request).not.toHaveBeenCalled();
    expect(verify.verifyBaseline).not.toHaveBeenCalled();
  });

  it('fails closed on a malformed create response', async () => {
    const verify = verifier();
    const request = vi
      .fn()
      .mockResolvedValueOnce({ id: ROLE_ID, name: 'wrong role' })
      .mockResolvedValueOnce([]);

    await expect(
      probeGuildRoleCreateQuota({
        rest: { request },
        verifyBaseline: verify.verifyBaseline,
        baseline: baseline(),
        guildId: GUILD_ID,
        botId: BOT_ID,
      }),
    ).rejects.toSatisfy((error) => {
      expect(error).toBeInstanceOf(BenchmarkQuotaPreflightError);
      expect(error.code).toBe('PREFLIGHT_ROLE_CREATE_RESPONSE_INVALID');
      expect(error.evidence.role_id).toBe(ROLE_ID);
      expect(error.evidence.baseline_restored).toBe(true);
      return true;
    });
    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenNthCalledWith(2, 'GET', `/guilds/${GUILD_ID}/roles`, {
      retry: true,
    });
    expect(verify.verifyBaseline).toHaveBeenCalledTimes(2);
  });

  it('recovers the known role after an ambiguous delete and still fails closed', async () => {
    const verify = verifier();
    const request = vi
      .fn()
      .mockResolvedValueOnce(temporaryRole())
      .mockRejectedValueOnce(new Error('delete unavailable'))
      .mockResolvedValueOnce([temporaryRole()])
      .mockResolvedValueOnce(null);

    await expect(
      probeGuildRoleCreateQuota({
        rest: { request },
        verifyBaseline: verify.verifyBaseline,
        baseline: baseline(),
        guildId: GUILD_ID,
        botId: BOT_ID,
      }),
    ).rejects.toSatisfy((error) => {
      expect(error).toBeInstanceOf(BenchmarkQuotaPreflightError);
      expect(error.code).toBe('PREFLIGHT_ROLE_DELETE_FAILED');
      expect(error.evidence.role_id).toBe(ROLE_ID);
      expect(error.evidence.baseline_restored).toBe(true);
      return true;
    });
    expect(request).toHaveBeenNthCalledWith(2, 'DELETE', `/guilds/${GUILD_ID}/roles/${ROLE_ID}`, {
      reason: 'discord-mcp benchmark quota preflight probe',
      retry: true,
    });
    expect(request).toHaveBeenNthCalledWith(3, 'GET', `/guilds/${GUILD_ID}/roles`, {
      retry: true,
    });
    expect(request).toHaveBeenNthCalledWith(4, 'DELETE', `/guilds/${GUILD_ID}/roles/${ROLE_ID}`, {
      reason: 'discord-mcp benchmark quota preflight probe',
      retry: true,
    });
    expect(verify.verifyBaseline).toHaveBeenCalledTimes(2);
  });

  it('never reports ready after the final exact baseline readback fails', async () => {
    const verify = verifier();
    verify.verifyBaseline
      .mockResolvedValueOnce({
        verified: true,
        guild_id: GUILD_ID,
        bot_id: BOT_ID,
        fingerprint: FINGERPRINT,
      })
      .mockRejectedValueOnce(new Error('final baseline drift'))
      .mockResolvedValueOnce({
        verified: true,
        guild_id: GUILD_ID,
        bot_id: BOT_ID,
        fingerprint: FINGERPRINT,
      });
    const request = vi
      .fn()
      .mockResolvedValueOnce(temporaryRole())
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce([]);

    await expect(
      probeGuildRoleCreateQuota({
        rest: { request },
        verifyBaseline: verify.verifyBaseline,
        baseline: baseline(),
        guildId: GUILD_ID,
        botId: BOT_ID,
      }),
    ).rejects.toSatisfy((error) => {
      expect(error).toBeInstanceOf(BenchmarkQuotaPreflightError);
      expect(error.code).toBe('PREFLIGHT_BASELINE_VERIFICATION_FAILED');
      expect(error.evidence.role_id).toBe(ROLE_ID);
      expect(error.evidence.baseline_restored).toBe(true);
      return true;
    });
    expect(request).toHaveBeenCalledTimes(3);
    expect(request).toHaveBeenNthCalledWith(3, 'GET', `/guilds/${GUILD_ID}/roles`, {
      retry: true,
    });
    expect(verify.verifyBaseline).toHaveBeenCalledTimes(3);
  });

  it('recovers a role created behind an ambiguous POST response by its unique name', async () => {
    const verify = verifier();
    const request = vi
      .fn()
      .mockRejectedValueOnce(new Error('socket closed after write'))
      .mockResolvedValueOnce([temporaryRole()])
      .mockResolvedValueOnce(null);

    await expect(
      probeGuildRoleCreateQuota({
        rest: { request },
        verifyBaseline: verify.verifyBaseline,
        baseline: baseline(),
        guildId: GUILD_ID,
        botId: BOT_ID,
      }),
    ).rejects.toSatisfy((error) => {
      expect(error).toBeInstanceOf(BenchmarkQuotaPreflightError);
      expect(error.code).toBe('PREFLIGHT_ROLE_CREATE_FAILED');
      expect(error.evidence.role_id).toBe(ROLE_ID);
      expect(error.evidence.baseline_restored).toBe(true);
      return true;
    });
    expect(request).toHaveBeenCalledTimes(3);
    expect(verify.verifyBaseline).toHaveBeenCalledTimes(2);
  });

  it('never substitutes another matching role when recovery already has the created role ID', async () => {
    const verify = verifier();
    verify.verifyBaseline
      .mockResolvedValueOnce({
        verified: true,
        guild_id: GUILD_ID,
        bot_id: BOT_ID,
        fingerprint: FINGERPRINT,
      })
      .mockRejectedValueOnce(new Error('baseline drift'));
    const request = vi
      .fn()
      .mockResolvedValueOnce(temporaryRole())
      .mockRejectedValueOnce(new Error('delete unavailable'))
      .mockResolvedValueOnce([temporaryRole(OTHER_ROLE_ID)]);

    await expect(
      probeGuildRoleCreateQuota({
        rest: { request },
        verifyBaseline: verify.verifyBaseline,
        baseline: baseline(),
        guildId: GUILD_ID,
        botId: BOT_ID,
      }),
    ).rejects.toSatisfy((error) => {
      expect(error).toBeInstanceOf(BenchmarkQuotaPreflightError);
      expect(error.code).toBe('PREFLIGHT_ROLE_DELETE_FAILED');
      expect(error.evidence.role_id).toBe(ROLE_ID);
      expect(error.evidence.baseline_restored).toBe(false);
      return true;
    });
    expect(request).toHaveBeenCalledTimes(3);
    expect(request).toHaveBeenNthCalledWith(3, 'GET', `/guilds/${GUILD_ID}/roles`, {
      retry: true,
    });
    expect(request).not.toHaveBeenCalledWith(
      'DELETE',
      `/guilds/${GUILD_ID}/roles/${OTHER_ROLE_ID}`,
      expect.anything(),
    );
  });

  it('never substitutes another matching role for a malformed response with a known ID', async () => {
    const verify = verifier();
    verify.verifyBaseline
      .mockResolvedValueOnce({
        verified: true,
        guild_id: GUILD_ID,
        bot_id: BOT_ID,
        fingerprint: FINGERPRINT,
      })
      .mockRejectedValueOnce(new Error('baseline drift'));
    const request = vi
      .fn()
      .mockResolvedValueOnce({ id: ROLE_ID, name: 'wrong role' })
      .mockResolvedValueOnce([temporaryRole(OTHER_ROLE_ID)]);

    await expect(
      probeGuildRoleCreateQuota({
        rest: { request },
        verifyBaseline: verify.verifyBaseline,
        baseline: baseline(),
        guildId: GUILD_ID,
        botId: BOT_ID,
      }),
    ).rejects.toSatisfy((error) => {
      expect(error).toBeInstanceOf(BenchmarkQuotaPreflightError);
      expect(error.code).toBe('PREFLIGHT_ROLE_CREATE_RESPONSE_INVALID');
      expect(error.evidence.role_id).toBe(ROLE_ID);
      expect(error.evidence.baseline_restored).toBe(false);
      return true;
    });
    expect(request).toHaveBeenCalledTimes(2);
    expect(request).not.toHaveBeenCalledWith(
      'DELETE',
      `/guilds/${GUILD_ID}/roles/${OTHER_ROLE_ID}`,
      expect.anything(),
    );
  });
});
