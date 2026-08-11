import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import { runBenchmarkSafetyCases } from './safety-cases.mjs';

const GUARD_GUILD = '999000999000999000';
const WRONG_GUILD = '999000999000999001';
const ACTIVE_BOT = '888000888000888000';
const WRONG_BOT = '888000888000888001';
const GUARD_CHANNEL = '777000777000777000';
const WRONG_CHANNEL = '777000777000777001';
const TOKEN = 'super-secret-token';

function snapshot(fingerprint = 'baseline', guildId = GUARD_GUILD, channelId = GUARD_CHANNEL) {
  return {
    fingerprint,
    guild: { id: guildId },
    bot: { user: { id: ACTIVE_BOT } },
    channels: [{ id: channelId, type: 0 }],
    recent_messages: { [channelId]: [] },
  };
}

function plan(targetGuildId, suppliedBotId, overrides = {}) {
  if (targetGuildId === GUARD_GUILD && suppliedBotId === ACTIVE_BOT) {
    return {
      status: 'ready',
      target: { guild_id: GUARD_GUILD, bot_id: ACTIVE_BOT },
      verification: { target_readback: 'passed' },
      operations: [{ operation_id: 'channel:create:general' }],
      blockers: [],
      ...overrides,
    };
  }
  return {
    status: 'blocked',
    target: null,
    verification: { target_readback: 'not_run' },
    operations: [],
    blockers: [
      {
        code: suppliedBotId === WRONG_BOT ? 'EXPECTED_BOT_MISMATCH' : 'GUILD_NOT_ALLOWED',
      },
    ],
    ...overrides,
  };
}

function harness({
  snapshotDrift = false,
  auditEntries = [],
  planOverrides,
  wrongGuildErrorCode = 'GUILD_NOT_ALLOWED',
  wrongGuildErrorSource = 'mcp_tool_result',
  openSessionErrorCode = null,
} = {}) {
  const openOptions = [];
  const closed = [];
  const snapshotCalls = [];
  const auditCursorCalls = [];
  const auditTrailCalls = [];
  let guardSnapshotReads = 0;
  const dependencies = {
    async openSession(options) {
      openOptions.push(options);
      if (openSessionErrorCode !== null) {
        const error = new Error(`MCP session startup failed (${openSessionErrorCode})`);
        error.code = openSessionErrorCode;
        throw error;
      }
      return {
        async callTool(name, args) {
          assert.equal(name, 'guild_blueprint_plan');
          if (args.guild_id === WRONG_GUILD && wrongGuildErrorCode !== undefined) {
            const error = new Error(`guild_blueprint_plan failed (${wrongGuildErrorCode})`);
            error.code = wrongGuildErrorCode;
            if (wrongGuildErrorSource !== null) error.source = wrongGuildErrorSource;
            throw error;
          }
          return plan(args.guild_id, args.expected_bot_id, planOverrides);
        },
        async close() {
          closed.push(true);
        },
      };
    },
    async readSnapshot({ guildId, botId, messageChannelIds }) {
      assert.ok(guildId === GUARD_GUILD || guildId === WRONG_GUILD);
      assert.equal(botId, ACTIVE_BOT);
      snapshotCalls.push({ guildId, messageChannelIds });
      if (guildId === WRONG_GUILD) {
        return snapshot('baseline', WRONG_GUILD, WRONG_CHANNEL);
      }
      guardSnapshotReads += 1;
      return snapshot(snapshotDrift && guardSnapshotReads === 2 ? 'drift' : 'baseline');
    },
    snapshotFingerprint(value) {
      return value.fingerprint;
    },
    async readAuditCursor({ guildId, botId }) {
      assert.ok(guildId === GUARD_GUILD || guildId === WRONG_GUILD);
      assert.equal(botId, ACTIVE_BOT);
      auditCursorCalls.push(guildId);
      return guildId === WRONG_GUILD ? '666000666000666001' : '666000666000666000';
    },
    async readAuditTrail({ guildId, botId, afterEntryId }) {
      assert.ok(guildId === GUARD_GUILD || guildId === WRONG_GUILD);
      assert.equal(botId, ACTIVE_BOT);
      assert.equal(
        afterEntryId,
        guildId === WRONG_GUILD ? '666000666000666001' : '666000666000666000',
      );
      auditTrailCalls.push(guildId);
      return { entries: guildId === WRONG_GUILD ? [] : auditEntries, complete: true };
    },
  };
  return {
    dependencies,
    openOptions,
    closed,
    snapshotCalls,
    auditCursorCalls,
    auditTrailCalls,
  };
}

function input(dependencies) {
  return {
    guardGuildId: GUARD_GUILD,
    wrongGuildId: WRONG_GUILD,
    guardMessageChannelId: GUARD_CHANNEL,
    wrongGuildMessageChannelId: WRONG_CHANNEL,
    activeBotId: ACTIVE_BOT,
    wrongBotId: WRONG_BOT,
    request: 'Build a safe community server',
    cliPath: 'dist/cli.js',
    cwd: 'C:/workspace',
    token: TOKEN,
    stateDirectory: 'C:/state',
    dependencies,
  };
}

describe('benchmark safety cases', () => {
  it('passes all three independent safety cases and keeps the token child-only', async () => {
    const test = harness();
    const evidence = await runBenchmarkSafetyCases(input(test.dependencies));

    assert.deepEqual(
      evidence.map(({ case: caseName, passed }) => ({ case: caseName, passed })),
      [
        { case: 'wrong_bot', passed: true },
        { case: 'wrong_guild', passed: true },
        { case: 'write_preview', passed: true },
      ],
    );
    assert.equal(test.closed.length, 3);
    for (const options of test.openOptions) {
      assert.deepEqual(options.env, {
        ALLOWED_GUILDS: GUARD_GUILD,
        DISCORD_EXPECTED_BOT_ID: ACTIVE_BOT,
        DISCORD_TOKEN: TOKEN,
        MCP_AUDIT_ENABLED: 'true',
        MCP_BLUEPRINT_STATE_DIR: 'C:/state',
        MCP_DRY_RUN: 'false',
        MCP_TOOL_SURFACE: 'full',
        MCP_WRITE_MODE: 'allow',
      });
      assert.equal(Object.hasOwn(options, 'token'), false);
    }
    assert.equal(JSON.stringify(evidence).includes(TOKEN), false);
    assert.equal(JSON.stringify(evidence).includes('plan_token'), false);
  });

  it('fails when the expected wrong-bot blocker is replaced', async () => {
    const test = harness({ planOverrides: { blockers: [{ code: 'TARGET_GUILD_NOT_ALLOWED' }] } });
    const evidence = await runBenchmarkSafetyCases(input(test.dependencies));

    assert.equal(evidence.find((item) => item.case === 'wrong_bot')?.passed, false);
  });

  it('accepts the public GUILD_NOT_ALLOWED tool error for wrong-guild evidence', async () => {
    const test = harness({ wrongGuildErrorCode: 'GUILD_NOT_ALLOWED' });
    const evidence = await runBenchmarkSafetyCases(input(test.dependencies));

    assert.equal(evidence.find((item) => item.case === 'wrong_guild')?.passed, true);
    assert.equal(
      evidence.find((item) => item.case === 'wrong_guild')?.blocker_code,
      'GUILD_NOT_ALLOWED',
    );
  });

  it('rejects a startup error carrying GUILD_NOT_ALLOWED as wrong-guild evidence', async () => {
    const test = harness({ openSessionErrorCode: 'GUILD_NOT_ALLOWED' });
    const evidence = await runBenchmarkSafetyCases(input(test.dependencies));
    const wrongGuild = evidence.find((item) => item.case === 'wrong_guild');

    assert.equal(wrongGuild?.passed, false);
    assert.equal(wrongGuild?.blocker_code, null);
    assert.equal(wrongGuild?.blocked_before_discord, false);
  });

  it('rejects a transport error carrying GUILD_NOT_ALLOWED as wrong-guild evidence', async () => {
    const test = harness({
      wrongGuildErrorCode: 'GUILD_NOT_ALLOWED',
      wrongGuildErrorSource: null,
    });
    const evidence = await runBenchmarkSafetyCases(input(test.dependencies));
    const wrongGuild = evidence.find((item) => item.case === 'wrong_guild');

    assert.equal(wrongGuild?.passed, false);
    assert.equal(wrongGuild?.blocker_code, null);
    assert.equal(wrongGuild?.blocked_before_discord, false);
  });

  it.each([
    'TARGET_GUILD_NOT_ALLOWED',
    'MCP_TOOL_ERROR',
    null,
  ])('rejects a wrong or missing public guild error code (%s)', async (wrongGuildErrorCode) => {
    const test = harness({ wrongGuildErrorCode });
    const evidence = await runBenchmarkSafetyCases(input(test.dependencies));

    assert.equal(evidence.find((item) => item.case === 'wrong_guild')?.passed, false);
  });

  it('fails when the guard snapshot drifts', async () => {
    const test = harness({ snapshotDrift: true });
    const evidence = await runBenchmarkSafetyCases(input(test.dependencies));

    assert.equal(evidence.find((item) => item.case === 'write_preview')?.snapshot_unchanged, false);
    assert.equal(evidence.find((item) => item.case === 'write_preview')?.passed, false);
  });

  it('fails when the audit trail reports a mutation', async () => {
    const test = harness({ auditEntries: [{ id: '555000555000555000' }] });
    const evidence = await runBenchmarkSafetyCases(input(test.dependencies));

    assert.equal(
      evidence.every((item) => item.audit_entry_count === 1),
      true,
    );
    assert.equal(
      evidence.every((item) => item.mutation_count === 1),
      true,
    );
    assert.equal(
      evidence.every((item) => item.passed === false),
      true,
    );
  });

  it('brackets all cases with one bounded shared evidence envelope', async () => {
    const test = harness();
    const evidence = await runBenchmarkSafetyCases(input(test.dependencies));

    assert.equal(evidence.find((item) => item.case === 'wrong_guild')?.passed, true);
    assert.deepEqual(test.snapshotCalls, [
      { guildId: GUARD_GUILD, messageChannelIds: [GUARD_CHANNEL] },
      { guildId: WRONG_GUILD, messageChannelIds: [WRONG_CHANNEL] },
      { guildId: GUARD_GUILD, messageChannelIds: [GUARD_CHANNEL] },
      { guildId: WRONG_GUILD, messageChannelIds: [WRONG_CHANNEL] },
    ]);
    assert.deepEqual(test.auditCursorCalls, [GUARD_GUILD, WRONG_GUILD]);
    assert.deepEqual(test.auditTrailCalls, [GUARD_GUILD, WRONG_GUILD]);
  });

  it('rejects aliased guild and canary identities before collecting evidence', async () => {
    const test = harness();
    const aliasedGuilds = input(test.dependencies);
    aliasedGuilds.wrongGuildId = GUARD_GUILD;
    await assert.rejects(runBenchmarkSafetyCases(aliasedGuilds), /guild IDs must be distinct/);

    const aliasedChannels = input(test.dependencies);
    aliasedChannels.wrongGuildMessageChannelId = GUARD_CHANNEL;
    await assert.rejects(runBenchmarkSafetyCases(aliasedChannels), /channel IDs must be distinct/);
    assert.equal(test.snapshotCalls.length, 0);
  });
});
