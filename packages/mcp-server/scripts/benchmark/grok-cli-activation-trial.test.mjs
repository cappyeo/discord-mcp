import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import {
  assertGrokCliActivationAuthReady,
  assertGrokCliConfigReady,
  assertGrokCliConfigWritable,
  buildGrokCliSetupArgs,
  createDefaultGrokCliActivationDependencies,
  GROK_CLI_ACTIVATION_CONFIRMATION_PREFIX,
  GROK_CLI_ACTIVATION_WRITE_CONFIRMATION_PREFIX,
  parseGrokCliActivationArgs,
  runGrokCliActivationTrial,
  validateGrokCliActivationRequest,
} from './grok-cli-activation-trial.mjs';

const RELEASE = '0.25.0';
const RUN_ID = 'grok-cli-activation-run-001';
const TRIAL_ID = 'grok-cli-activation-001';
const GUILD_ID = '1537332825978568744';
const BOT_ID = '1533719084636700773';
const TOKEN = 'token-never-in-artifact';
const target = {
  guildId: GUILD_ID,
  botId: BOT_ID,
  controlled: true,
  callerOwned: true,
};
const digest = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`;

function request(overrides = {}) {
  return {
    release: RELEASE,
    runId: RUN_ID,
    trialId: TRIAL_ID,
    hostVersion: '1.0.3',
    sourceCommit: 'a'.repeat(40),
    target,
    token: TOKEN,
    executionMode: 'test',
    operatorConfirmation: `${GROK_CLI_ACTIVATION_CONFIRMATION_PREFIX}${RELEASE}:${TRIAL_ID}`,
    writeApproval: `${GROK_CLI_ACTIVATION_WRITE_CONFIRMATION_PREFIX}${RELEASE}:${TRIAL_ID}`,
    ...overrides,
  };
}

function guidedConfig() {
  return {
    mcp_servers: {
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
        enabled: true,
        startup_timeout_sec: 90,
        tool_timeout_sec: 180,
      },
    },
  };
}

function allowConfig(state) {
  return {
    mcp_servers: {
      'discord-mcp': {
        ...guidedConfig().mcp_servers['discord-mcp'],
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
  const root = await mkdtemp(join(tmpdir(), 'grok-cli-activation-test-'));
  const state = {
    root,
    home: join(root, 'home'),
    installRoot: join(root, 'install'),
    profileRoot: join(root, 'profile'),
    profileEnvironmentKey: 'XDG_CONFIG_HOME',
    configPath: join(root, 'config.toml'),
    stateDirectory: join(root, 'state'),
    cleanProfile: true,
  };
  const binding = { guildId: GUILD_ID, botId: BOT_ID };
  const install = {
    sourceCommit: 'a'.repeat(40),
    cliDigest: digest('cli'),
    coreDigest: digest('core'),
    packageDigest: digest('package'),
  };
  const writable = allowConfig(state);
  const dependencies = {
    executionProvenance: {
      execution_mode: 'test',
      adapter_id: 'grok-cli-test-fixture',
      abortable: true,
      package_source: 'test_fixture',
    },
    workspace: {
      async create() {
        return state;
      },
      async readText() {
        return guidedConfig();
      },
      async writeText() {},
      async remove() {
        return { removed: true, verified: true };
      },
    },
    async captureBaseline() {
      return { beforeDigest: digest('baseline') };
    },
    async install() {
      return install;
    },
    async setup() {
      return {
        exitCode: 0,
        administratorWarning: false,
        config: guidedConfig(),
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
        launcherDigest: digest('launcher'),
        sessionDigest: digest('session'),
      };
    },
    async apply() {
      return { binding, status: 'complete' };
    },
    async evidence() {
      return {
        binding,
        status: 'verified',
        activityEvidence: {
          schema_version: 'guild_blueprint_activity_evidence.v1',
          status: 'verified',
          evidence_id: digest('evidence'),
          target: { guild_id: GUILD_ID, bot_id: BOT_ID },
        },
      };
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
      return { restored: true, exact: true, afterDigest: digest('baseline') };
    },
    async persistAttestation({ digest: attestationDigest }) {
      return { persisted: true, digest: attestationDigest };
    },
  };
  return { root, state, dependencies, install, writable };
}

describe('Grok CLI activation trial guard', () => {
  it('requires the Grok credential before live work', () => {
    expect(() => assertGrokCliActivationAuthReady({})).toThrow('XAI_API_KEY preflight failed');
    expect(assertGrokCliActivationAuthReady({ XAI_API_KEY: 'key' })).toBe(true);
  });

  it('binds operator consent to host, release, and trial', () => {
    const value = validateGrokCliActivationRequest({
      release: '0.25.0',
      runId: 'run-001',
      trialId: 'trial-001',
      hostVersion: '1.2.3',
      sourceCommit: 'a'.repeat(40),
      target,
      operatorConfirmation: 'APPROVE_GROK_CLI_ACTIVATION:0.25.0:trial-001',
      token: 'discord-token',
      executionMode: 'test',
    });
    expect(value.target).toMatchObject(target);
    expect(() =>
      validateGrokCliActivationRequest({
        release: '0.25.0',
        runId: 'run-001',
        trialId: 'trial-001',
        hostVersion: '1.2.3',
        sourceCommit: 'a'.repeat(40),
        target,
        operatorConfirmation: 'wrong',
        token: 'discord-token',
      }),
    ).toThrow('operator confirmation');
  });

  it('builds a pinned guided setup command and rejects config drift', () => {
    const configPath = join(tmpdir(), 'discord-mcp-grok-config.toml');
    expect(
      buildGrokCliSetupArgs({
        profile: 'devbot',
        guildId: target.guildId,
        configPath,
      }),
    ).toEqual([
      'setup',
      '--profile',
      'devbot',
      '--client',
      'grok-cli',
      '--allowed-guilds',
      target.guildId,
      '--output',
      configPath,
      '--force',
      '--json',
    ]);
    const config = {
      mcp_servers: {
        'discord-mcp': {
          command: 'npx',
          args: [
            '--yes',
            '--loglevel=error',
            '@discord-mcp/cli@0.25.0',
            'serve',
            '--profile',
            'devbot',
          ],
          enabled: true,
          startup_timeout_sec: 90,
          tool_timeout_sec: 180,
        },
      },
    };
    expect(
      assertGrokCliConfigReady(config, {
        release: '0.25.0',
        profile: 'devbot',
        token: 'discord-token',
      }),
    ).toBe(true);
    config.mcp_servers['discord-mcp'].args[2] = '@discord-mcp/cli@0.22.0';
    expect(() =>
      assertGrokCliConfigReady(config, { release: '0.25.0', profile: 'devbot' }),
    ).toThrow('pinned');
    expect(() =>
      assertGrokCliConfigReady(
        '[permission]\nrules = []\n\n[mcp_servers.discord-mcp]\ncommand = "npx"\n',
        { release: '0.25.0', profile: 'devbot' },
      ),
    ).toThrow('only the generated Grok MCP tables');
    expect(() =>
      assertGrokCliConfigReady(
        'XAI_API_KEY = "persisted"\n\n[mcp_servers.discord-mcp]\ncommand = "npx"\n',
        { release: '0.25.0', profile: 'devbot' },
      ),
    ).toThrow('only the generated Grok MCP tables');
  });

  it('rejects malformed CLI arguments before running a trial', () => {
    expect(() => parseGrokCliActivationArgs([])).toThrow('invalid Grok activation arguments');
    expect(() =>
      createDefaultGrokCliActivationDependencies(Object.create({ runCommand() {} })),
    ).toThrow('must not inherit');
  });

  it('runs the complete shared lifecycle and emits a secret-free Grok artifact', async () => {
    const fixture = await fakeDependencies();
    try {
      let clockValue = 0;
      const result = await runGrokCliActivationTrial({
        ...request({ dependencies: fixture.dependencies }),
        clock: { now: () => clockValue++ },
      });
      expect(result).toMatchObject({
        ok: true,
        artifact: {
          schema_version: 'discord-mcp.activation-trial.v3',
          host: 'grok-cli',
          result: 'passed',
        },
      });
      expect(JSON.stringify(result)).not.toContain(TOKEN);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it('writes and revalidates an exact target-bound config.toml', async () => {
    const fixture = await fakeDependencies();
    try {
      const dependencies = createDefaultGrokCliActivationDependencies({
        environment: { PATH: process.env.PATH, XAI_API_KEY: 'model-key' },
      });
      const result = await dependencies.enableWrites({
        configPath: fixture.state.configPath,
        request: request(),
        workspaceState: fixture.state,
        install: fixture.install,
      });
      expect(result.config).toEqual(fixture.writable);
      const persisted = await readFile(fixture.state.configPath, 'utf8');
      expect(persisted).toContain('[mcp_servers.discord-mcp]');
      expect(persisted).toContain('[mcp_servers.discord-mcp.env]');
      expect(() =>
        assertGrokCliConfigWritable(persisted, {
          request: request(),
          workspaceState: fixture.state,
          install: fixture.install,
        }),
      ).not.toThrow();
      expect(persisted).not.toMatch(/DISCORD_TOKEN|XAI_API_KEY/iu);

      fixture.writable.mcp_servers['discord-mcp'].env.ALLOWED_GUILDS = BOT_ID;
      expect(() =>
        assertGrokCliConfigWritable(fixture.writable, {
          request: request(),
          workspaceState: fixture.state,
          install: fixture.install,
        }),
      ).toThrow(/target-bound/u);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
});
