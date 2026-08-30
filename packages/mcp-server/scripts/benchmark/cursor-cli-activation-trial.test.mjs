import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  assertCursorCliActivationAuthReady,
  assertCursorCliConfigReady,
  assertCursorCliConfigWritable,
  buildCursorCliSetupArgs,
  CURSOR_CLI_ACTIVATION_CONFIRMATION_PREFIX,
  CURSOR_CLI_ACTIVATION_WRITE_CONFIRMATION_PREFIX,
  createDefaultCursorCliActivationDependencies,
  main,
  parseCursorCliActivationArgs,
  parseCursorCliSetupJson,
  runCursorCliActivationTrial,
  validateCursorCliActivationRequest,
} from './cursor-cli-activation-trial.mjs';

const RELEASE = '0.25.1';
const RUN_ID = 'cursor-cli-activation-run-001';
const TRIAL_ID = 'cursor-cli-activation-001';
const GUILD_ID = '1537332825978568744';
const BOT_ID = '1533719084636700773';
const TOKEN = 'token-never-in-artifact';
const TARGET = { guildId: GUILD_ID, botId: BOT_ID, controlled: true, callerOwned: true };
const DIGEST = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`;

function request(overrides = {}) {
  return {
    release: RELEASE,
    runId: RUN_ID,
    trialId: TRIAL_ID,
    hostVersion: '2.4.1',
    sourceCommit: 'a'.repeat(40),
    target: TARGET,
    token: TOKEN,
    executionMode: 'test',
    operatorConfirmation: `${CURSOR_CLI_ACTIVATION_CONFIRMATION_PREFIX}${RELEASE}:${TRIAL_ID}`,
    writeApproval: `${CURSOR_CLI_ACTIVATION_WRITE_CONFIRMATION_PREFIX}${RELEASE}:${TRIAL_ID}`,
    ...overrides,
  };
}

function guidedConfig() {
  return {
    mcpServers: {
      'discord-mcp': {
        command: 'npx',
        args: [
          '--yes',
          '--loglevel=error',
          `@discord-mcp/cli@${RELEASE}`,
          'serve',
          '--profile',
          `activation-${TRIAL_ID}`,
        ],
      },
    },
  };
}

function allowConfig(state) {
  return {
    mcpServers: {
      'discord-mcp': {
        ...guidedConfig().mcpServers['discord-mcp'],
        env: {
          DISCORD_EXPECTED_BOT_ID: BOT_ID,
          DISCORD_DEFAULT_GUILD_ID: GUILD_ID,
          ALLOWED_GUILDS: GUILD_ID,
          MCP_TOOL_SURFACE: 'progressive',
          MCP_AUDIT_ENABLED: 'true',
          MCP_AUDIT_SINK: 'file',
          MCP_AUDIT_FILE: join(state.stateDirectory, 'audit.jsonl'),
          MCP_BLUEPRINT_STATE_DIR: state.stateDirectory,
          MCP_WRITE_MODE: 'allow',
          MCP_DRY_RUN: 'false',
        },
      },
    },
  };
}

async function fakeDependencies() {
  const root = await mkdtemp(join(tmpdir(), 'cursor-cli-activation-test-'));
  const state = {
    root,
    home: join(root, 'home'),
    installRoot: join(root, 'install'),
    profileRoot: join(root, 'profile'),
    profileEnvironmentKey: 'XDG_CONFIG_HOME',
    configPath: join(root, 'mcp.json'),
    stateDirectory: join(root, 'state'),
    cleanProfile: true,
  };
  const binding = { guildId: GUILD_ID, botId: BOT_ID };
  const evidence = {
    schema_version: 'guild_blueprint_activity_evidence.v1',
    status: 'verified',
    evidence_id: DIGEST('evidence'),
    target: { guild_id: GUILD_ID, bot_id: BOT_ID },
  };
  const install = {
    sourceCommit: 'a'.repeat(40),
    cliDigest: DIGEST('cli'),
    coreDigest: DIGEST('core'),
    packageDigest: DIGEST('package'),
  };
  const config = JSON.stringify(guidedConfig());
  const writable = allowConfig(state);
  const dependencies = {
    executionProvenance: {
      execution_mode: 'test',
      adapter_id: 'cursor-cli-test-fixture',
      abortable: true,
      package_source: 'test_fixture',
    },
    workspace: {
      async create() {
        return state;
      },
      async readText() {
        return config;
      },
      async writeText() {},
      async remove() {
        return { removed: true, verified: true };
      },
    },
    async captureBaseline() {
      return { beforeDigest: DIGEST('baseline') };
    },
    async install() {
      return install;
    },
    async setup() {
      return {
        exitCode: 0,
        administratorWarning: false,
        config,
        binding,
        bindingVerified: true,
      };
    },
    async enableWrites() {
      return { config: writable };
    },
    async launch({ env }) {
      expect(env).toEqual({
        DISCORD_TOKEN: TOKEN,
        MCP_DRY_RUN: 'false',
        MCP_WRITE_MODE: 'allow',
      });
      return {
        binding,
        clientReady: true,
        firstRequest: true,
        isolated: true,
        launcherDigest: DIGEST('launcher'),
        sessionDigest: DIGEST('session'),
      };
    },
    async apply() {
      return { binding, status: 'complete' };
    },
    async evidence() {
      return { binding, status: 'verified', activityEvidence: evidence };
    },
    async validateActivityEvidence() {
      return true;
    },
    async closeSession() {
      return { settled: true };
    },
    async restoreBaseline() {
      return { restored: true };
    },
    async verifyBaseline() {
      return { restored: true, exact: true, afterDigest: DIGEST('baseline') };
    },
    async persistAttestation({ digest }) {
      return { persisted: true, digest };
    },
  };
  return { root, state, dependencies, install, writable };
}

function cliArgs() {
  return [
    '--release',
    RELEASE,
    '--run-id',
    RUN_ID,
    '--trial-id',
    TRIAL_ID,
    '--host-version',
    '2.4.1',
    '--source-commit',
    'a'.repeat(40),
    '--guild',
    GUILD_ID,
    '--confirmation',
    `${CURSOR_CLI_ACTIVATION_CONFIRMATION_PREFIX}${RELEASE}:${TRIAL_ID}`,
    '--write-approval',
    `${CURSOR_CLI_ACTIVATION_WRITE_CONFIRMATION_PREFIX}${RELEASE}:${TRIAL_ID}`,
  ];
}

describe('Cursor Agent CLI activation trial', () => {
  it('validates host auth, confirmations, caller ownership, and token normalization', () => {
    expect(assertCursorCliActivationAuthReady({ CURSOR_API_KEY: 'model-key' })).toBe(true);
    expect(() => assertCursorCliActivationAuthReady({})).toThrow(/preflight failed/);
    expect(validateCursorCliActivationRequest(request({ token: `Bot ${TOKEN}` })).token).toBe(
      TOKEN,
    );
    expect(() =>
      validateCursorCliActivationRequest(request({ operatorConfirmation: 'wrong' })),
    ).toThrow(/confirmation/);
    expect(() =>
      validateCursorCliActivationRequest(request({ target: { ...TARGET, callerOwned: false } })),
    ).toThrow(/caller-owned/);
  });

  it('requires exact guided bot and guild proof', () => {
    const output = JSON.stringify({
      ok: true,
      data: { discord: { bot: { id: BOT_ID } }, allowedGuilds: [GUILD_ID] },
    });
    expect(parseCursorCliSetupJson(output, TARGET).bindingVerified).toBe(true);
    expect(() =>
      parseCursorCliSetupJson(output, { ...TARGET, botId: '1533719084636700774' }),
    ).toThrow(/bot binding/);
    expect(() =>
      parseCursorCliSetupJson(
        JSON.stringify({
          ok: true,
          data: {
            discord: { bot: { id: BOT_ID } },
            allowedGuilds: [GUILD_ID, '1533719084636700775'],
          },
        }),
        TARGET,
      ),
    ).toThrow(/guild binding/);
  });

  it('runs one complete fake lifecycle and emits a secret-free host artifact', async () => {
    const fixture = await fakeDependencies();
    try {
      let clockValue = 0;
      const result = await runCursorCliActivationTrial({
        ...request({ dependencies: fixture.dependencies }),
        clock: { now: () => clockValue++ },
      });
      expect(result).toMatchObject({
        ok: true,
        artifact: {
          schema_version: 'discord-mcp.activation-trial.v3',
          host: 'cursor-cli',
          result: 'passed',
        },
      });
      expect(JSON.stringify(result)).not.toContain(TOKEN);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it('builds exact setup and a secret-free target-bound write config', async () => {
    const configPath = resolve(tmpdir(), 'mcp.json');
    expect(
      buildCursorCliSetupArgs({
        profile: `activation-${TRIAL_ID}`,
        guildId: GUILD_ID,
        configPath,
      }),
    ).toEqual([
      'setup',
      '--profile',
      `activation-${TRIAL_ID}`,
      '--client',
      'cursor-cli',
      '--allowed-guilds',
      GUILD_ID,
      '--output',
      configPath,
      '--force',
      '--json',
    ]);
    expect(() =>
      assertCursorCliConfigReady(guidedConfig(), {
        release: RELEASE,
        token: TOKEN,
        profile: `activation-${TRIAL_ID}`,
      }),
    ).not.toThrow();

    const fixture = await fakeDependencies();
    try {
      const dependencies = createDefaultCursorCliActivationDependencies({
        environment: { PATH: process.env.PATH, CURSOR_API_KEY: 'model-key' },
      });
      const result = await dependencies.enableWrites({
        configPath: fixture.state.configPath,
        request: request(),
        workspaceState: fixture.state,
        install: fixture.install,
      });
      expect(result.config).toEqual(fixture.writable);
      expect(JSON.parse(await readFile(fixture.state.configPath, 'utf8'))).toEqual(
        fixture.writable,
      );
      expect(() =>
        assertCursorCliConfigWritable(result.config, {
          request: request(),
          workspaceState: fixture.state,
          install: fixture.install,
        }),
      ).not.toThrow();
      expect(JSON.stringify(result.config)).not.toMatch(/DISCORD_TOKEN|CURSOR_API_KEY/iu);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it('rejects credential material, an unpinned release, and target drift', async () => {
    expect(() =>
      assertCursorCliConfigReady(
        { ...guidedConfig(), secret: TOKEN },
        { release: RELEASE, token: TOKEN, profile: `activation-${TRIAL_ID}` },
      ),
    ).toThrow(/Discord token/);
    expect(() =>
      assertCursorCliConfigReady(guidedConfig(), {
        release: '9.9.9',
        token: TOKEN,
        profile: `activation-${TRIAL_ID}`,
      }),
    ).toThrow(/pinned/);
    const fixture = await fakeDependencies();
    try {
      fixture.writable.mcpServers['discord-mcp'].env.ALLOWED_GUILDS = '1533719084636700775';
      expect(() =>
        assertCursorCliConfigWritable(fixture.writable, {
          request: request(),
          workspaceState: fixture.state,
          install: fixture.install,
        }),
      ).toThrow(/target-bound/);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it('fails missing default model auth before workspace side effects', async () => {
    vi.stubEnv('CURSOR_API_KEY', '');
    const prefix = `discord-mcp-cursor-cli-${TRIAL_ID}-`;
    const before = (await readdir(tmpdir())).filter((name) => name.startsWith(prefix)).sort();
    try {
      const dependencies = createDefaultCursorCliActivationDependencies();
      await expect(
        runCursorCliActivationTrial(request({ executionMode: 'live', dependencies })),
      ).rejects.toThrow(/CURSOR_API_KEY preflight failed/);
      const after = (await readdir(tmpdir())).filter((name) => name.startsWith(prefix)).sort();
      expect(after).toEqual(before);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('never trusts an injected dependency factory for a live trial', async () => {
    let commandCalled = false;
    const dependencies = createDefaultCursorCliActivationDependencies({
      runCommand: async () => {
        commandCalled = true;
        return { code: 0 };
      },
    });
    await expect(
      runCursorCliActivationTrial(request({ dependencies, executionMode: 'live' })),
    ).rejects.toThrow(/built-in audited dependency adapter/);
    expect(commandCalled).toBe(false);
  });

  it('parses the exact operator CLI and emits only secret-free envelopes', async () => {
    expect(parseCursorCliActivationArgs(cliArgs())).toMatchObject({
      release: RELEASE,
      runId: RUN_ID,
      trialId: TRIAL_ID,
      hostVersion: '2.4.1',
      guildId: GUILD_ID,
    });
    let received;
    let output = '';
    const code = await main({
      argv: cliArgs(),
      environment: { DISCORD_TESTBOT_B_TOKEN: `Bot ${TOKEN}` },
      stdout: { write: (value) => (output += value) },
      runTrial: async (options) => {
        received = options;
        return { ok: true, artifact: { schema_version: 'fixture' } };
      },
    });
    expect(code).toBe(0);
    expect(received).toMatchObject({
      token: TOKEN,
      executionMode: 'live',
      target: { guildId: GUILD_ID, botId: BOT_ID, controlled: true, callerOwned: true },
    });
    expect(output).not.toContain(TOKEN);

    let failure = '';
    const failureCode = await main({
      argv: cliArgs(),
      environment: { DISCORD_TESTBOT_B_TOKEN: TOKEN },
      stdout: { write: (value) => (failure += value) },
      runTrial: async () => ({ ok: false, artifact: { model: 'CURSOR_API_KEY', token: TOKEN } }),
    });
    expect(failureCode).toBe(1);
    expect(failure).not.toContain(TOKEN);
    expect(failure).not.toContain('CURSOR_API_KEY');
  });

  it('rejects duplicate, incomplete, unknown, or uncontrolled CLI arguments', () => {
    const complete = cliArgs();
    expect(() => parseCursorCliActivationArgs(complete.slice(0, -2))).toThrow(/invalid/);
    expect(() => parseCursorCliActivationArgs([...complete, '--release', RELEASE])).toThrow(
      /invalid/,
    );
    expect(() => parseCursorCliActivationArgs([...complete, '--unknown', 'value'])).toThrow(
      /invalid/,
    );
    const uncontrolled = [...complete];
    uncontrolled[uncontrolled.indexOf('--guild') + 1] = '1533719084636700999';
    expect(() => parseCursorCliActivationArgs(uncontrolled)).toThrow(/invalid/);
  });
});
