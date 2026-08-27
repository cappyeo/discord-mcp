import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  assertClaudeCodeConfigReady,
  assertClaudeCodeConfigWritable,
  buildClaudeCodeSetupArgs,
  CLAUDE_CODE_ACTIVATION_CONFIRMATION_PREFIX,
  CLAUDE_CODE_ACTIVATION_WRITE_CONFIRMATION_PREFIX,
  createDefaultClaudeCodeActivationDependencies,
  main,
  parseClaudeCodeActivationArgs,
  parseClaudeCodeSetupJson,
  runClaudeCodeActivationTrial,
  validateClaudeCodeActivationRequest,
} from './claude-code-activation-trial.mjs';
import { buildClaudeCodeMcpConfig } from './claude-code-driver.mjs';

const RELEASE = '0.23.0';
const RUN_ID = 'claude-code-activation-run-001';
const TRIAL_ID = 'claude-code-activation-001';
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
    hostVersion: '1.0.0',
    sourceCommit: 'a'.repeat(40),
    target: TARGET,
    token: TOKEN,
    executionMode: 'test',
    operatorConfirmation: `${CLAUDE_CODE_ACTIVATION_CONFIRMATION_PREFIX}${RELEASE}:${TRIAL_ID}`,
    writeApproval: `${CLAUDE_CODE_ACTIVATION_WRITE_CONFIRMATION_PREFIX}${RELEASE}:${TRIAL_ID}`,
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

async function fakeDependencies() {
  const root = await mkdtemp(join(tmpdir(), 'claude-code-activation-test-'));
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
  const allowConfig = buildClaudeCodeMcpConfig({
    cliPath: join(state.installRoot, 'node_modules', '@discord-mcp', 'cli', 'dist', 'cli.js'),
    target: TARGET,
    stateDirectory: state.stateDirectory,
    mode: 'allow',
  });
  const dependencies = {
    executionProvenance: {
      execution_mode: 'test',
      adapter_id: 'claude-code-test-fixture',
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
      return { config: allowConfig };
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
  return { root, state, dependencies, install, allowConfig };
}

describe('Claude Code activation trial', () => {
  it('validates confirmations, binding and Bot token normalization', () => {
    const normalized = validateClaudeCodeActivationRequest({
      ...request({ token: `Bot ${TOKEN}` }),
    });
    expect(normalized.token).toBe(TOKEN);
    expect(() =>
      validateClaudeCodeActivationRequest(request({ operatorConfirmation: 'wrong' })),
    ).toThrow(/confirmation/);
    expect(() =>
      validateClaudeCodeActivationRequest(request({ target: { ...TARGET, callerOwned: false } })),
    ).toThrow(/caller-owned/);
  });

  it('requires exact guided bot and guild proof', () => {
    const output = JSON.stringify({
      ok: true,
      data: { discord: { bot: { id: BOT_ID } }, allowedGuilds: [GUILD_ID] },
    });
    expect(parseClaudeCodeSetupJson(output, TARGET).bindingVerified).toBe(true);
    expect(() =>
      parseClaudeCodeSetupJson(output, { ...TARGET, botId: '1533719084636700774' }),
    ).toThrow(/bot binding/);
    expect(() =>
      parseClaudeCodeSetupJson(output, { ...TARGET, guildId: '1533719084636700775' }),
    ).toThrow(/guild binding/);
    expect(() =>
      parseClaudeCodeSetupJson(
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
    expect(() => parseClaudeCodeSetupJson('{', TARGET)).toThrow(/invalid JSON/);
    expect(() =>
      parseClaudeCodeSetupJson(JSON.stringify({ ok: false, exitCode: 1 }), TARGET),
    ).toThrow(/not successful/);
  });

  it('runs a complete fake lifecycle with a secret-free Claude artifact', async () => {
    const fixture = await fakeDependencies();
    try {
      let clockValue = 0;
      const result = await runClaudeCodeActivationTrial({
        ...request({ dependencies: fixture.dependencies }),
        clock: { now: () => clockValue++ },
      });
      expect(result.ok).toBe(true);
      expect(result.artifact).toMatchObject({
        schema_version: 'discord-mcp.activation-trial.v3',
        host: 'claude-code',
        result: 'passed',
      });
      expect(JSON.stringify(result.artifact)).not.toContain(TOKEN);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it('rewrites guided config before launch in the full trial lifecycle', async () => {
    const fixture = await fakeDependencies();
    const order = [];
    fixture.dependencies.setup = async ({ configPath }) => {
      order.push('setup');
      await writeFile(configPath, JSON.stringify(guidedConfig()), 'utf8');
      return {
        exitCode: 0,
        administratorWarning: false,
        config: JSON.stringify(guidedConfig()),
        binding: { guildId: GUILD_ID, botId: BOT_ID },
        bindingVerified: true,
      };
    };
    fixture.dependencies.enableWrites = async ({ configPath }) => {
      order.push('enableWrites');
      await writeFile(configPath, JSON.stringify(fixture.allowConfig), 'utf8');
      return { config: fixture.allowConfig };
    };
    fixture.dependencies.launch = async ({ configPath }) => {
      order.push('launch');
      expect(JSON.parse(await readFile(configPath, 'utf8'))).toEqual(fixture.allowConfig);
      return {
        binding: { guildId: GUILD_ID, botId: BOT_ID },
        clientReady: true,
        firstRequest: true,
        isolated: true,
        launcherDigest: DIGEST('launcher'),
        sessionDigest: DIGEST('session'),
      };
    };
    try {
      const result = await runClaudeCodeActivationTrial({
        ...request({ dependencies: fixture.dependencies }),
        clock: { now: () => 0 },
      });
      expect(result.ok).toBe(true);
      expect(order).toEqual(['setup', 'enableWrites', 'launch']);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it('fails missing default Anthropic auth before workspace side effects', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    const prefix = `discord-mcp-claude-code-${TRIAL_ID}-`;
    const before = (await readdir(tmpdir())).filter((name) => name.startsWith(prefix)).sort();
    try {
      const dependencies = createDefaultClaudeCodeActivationDependencies();
      await expect(
        runClaudeCodeActivationTrial(request({ executionMode: 'live', dependencies })),
      ).rejects.toThrow(/ANTHROPIC_API_KEY preflight failed/);
      const after = (await readdir(tmpdir())).filter((name) => name.startsWith(prefix)).sort();
      expect(after).toEqual(before);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('does not trust non-enumerable injected live seams', async () => {
    let commandCalled = false;
    const options = {};
    Object.defineProperty(options, 'runCommand', {
      value: async () => {
        commandCalled = true;
        return { code: 0 };
      },
    });
    const dependencies = createDefaultClaudeCodeActivationDependencies(options);
    await expect(
      runClaudeCodeActivationTrial(request({ dependencies, executionMode: 'live' })),
    ).rejects.toThrow(/built-in audited dependency adapter/);
    expect(commandCalled).toBe(false);
  });

  it('does not trust a proxy-hidden live seam', async () => {
    let commandCalled = false;
    const injected = async () => {
      commandCalled = true;
      return { code: 0 };
    };
    const options = new Proxy(
      {},
      {
        get(target, property, receiver) {
          if (property === 'runCommand') return injected;
          return Reflect.get(target, property, receiver);
        },
      },
    );
    const dependencies = createDefaultClaudeCodeActivationDependencies(options);
    await expect(
      runClaudeCodeActivationTrial(request({ dependencies, executionMode: 'live' })),
    ).rejects.toThrow(/built-in audited dependency adapter/);
    expect(commandCalled).toBe(false);
  });

  it('builds the exact guided setup command and canonical allow config', async () => {
    const setupConfigPath = resolve(tmpdir(), 'mcp.json');
    const args = buildClaudeCodeSetupArgs({
      profile: `activation-${TRIAL_ID}`,
      guildId: GUILD_ID,
      configPath: setupConfigPath,
    });
    expect(args).toEqual([
      'setup',
      '--profile',
      `activation-${TRIAL_ID}`,
      '--client',
      'claude-code',
      '--allowed-guilds',
      GUILD_ID,
      '--output',
      setupConfigPath,
      '--force',
      '--json',
    ]);
    const root = await mkdtemp(join(tmpdir(), 'claude-code-config-test-'));
    try {
      const state = {
        installRoot: root,
        stateDirectory: root,
      };
      const dependencies = createDefaultClaudeCodeActivationDependencies({
        environment: { PATH: process.env.PATH },
      });
      const configPath = join(root, 'mcp.json');
      const result = await dependencies.enableWrites({
        configPath,
        request: request(),
        workspaceState: state,
        install: { cliDigest: DIGEST('cli') },
      });
      expect(result.config.mcpServers['discord-mcp'].env.MCP_DRY_RUN).toBe('false');
      expect(JSON.parse(await readFile(configPath, 'utf8'))).toEqual(result.config);
      assertClaudeCodeConfigWritable(result.config, {
        request: request(),
        workspaceState: state,
        install: { cliDigest: DIGEST('cli') },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects raw secrets or unpinned generated config', () => {
    expect(() =>
      assertClaudeCodeConfigReady(guidedConfig(), {
        release: RELEASE,
        token: TOKEN,
        profile: `activation-${TRIAL_ID}`,
      }),
    ).not.toThrow();
    expect(() =>
      assertClaudeCodeConfigReady(guidedConfig(), {
        release: '9.9.9',
        token: TOKEN,
        profile: `activation-${TRIAL_ID}`,
      }),
    ).toThrow(/release/);
    expect(() =>
      assertClaudeCodeConfigReady(
        { ...guidedConfig(), secret: TOKEN },
        { release: RELEASE, token: TOKEN, profile: `activation-${TRIAL_ID}` },
      ),
    ).toThrow(/Discord token/);
    const configWithUnexpectedEnv = guidedConfig();
    configWithUnexpectedEnv.mcpServers['discord-mcp'].env = {
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal placeholder must be rejected
      DISCORD_TOKEN: '${DISCORD_TOKEN}',
    };
    expect(() =>
      assertClaudeCodeConfigReady(configWithUnexpectedEnv, {
        release: RELEASE,
        token: TOKEN,
        profile: `activation-${TRIAL_ID}`,
      }),
    ).toThrow(/release and profile command/);
  });

  it('emits a secret-free CLI failure envelope', async () => {
    let output = '';
    const code = await main({
      argv: [],
      environment: { DISCORD_TESTBOT_B_TOKEN: TOKEN },
      stdout: {
        write(value) {
          output += value;
        },
      },
    });
    expect(code).toBe(1);
    expect(output).not.toContain(TOKEN);
    expect(output).not.toContain('ANTHROPIC');
  });

  it('parses the exact CLI contract and passes a normalized caller-owned target to the trial', async () => {
    const argv = [
      '--release',
      RELEASE,
      '--run-id',
      RUN_ID,
      '--trial-id',
      TRIAL_ID,
      '--host-version',
      '2.1.228',
      '--source-commit',
      'a'.repeat(40),
      '--guild',
      GUILD_ID,
      '--confirmation',
      `${CLAUDE_CODE_ACTIVATION_CONFIRMATION_PREFIX}${RELEASE}:${TRIAL_ID}`,
      '--write-approval',
      `${CLAUDE_CODE_ACTIVATION_WRITE_CONFIRMATION_PREFIX}${RELEASE}:${TRIAL_ID}`,
    ];
    expect(parseClaudeCodeActivationArgs(argv)).toEqual({
      release: RELEASE,
      runId: RUN_ID,
      trialId: TRIAL_ID,
      hostVersion: '2.1.228',
      sourceCommit: 'a'.repeat(40),
      guildId: GUILD_ID,
      operatorConfirmation: `${CLAUDE_CODE_ACTIVATION_CONFIRMATION_PREFIX}${RELEASE}:${TRIAL_ID}`,
      writeApproval: `${CLAUDE_CODE_ACTIVATION_WRITE_CONFIRMATION_PREFIX}${RELEASE}:${TRIAL_ID}`,
    });

    let received;
    let output = '';
    const code = await main({
      argv,
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
      target: {
        guildId: GUILD_ID,
        botId: BOT_ID,
        controlled: true,
        callerOwned: true,
      },
    });
    expect(JSON.parse(output)).toEqual({ ok: true, artifact: { schema_version: 'fixture' } });
    expect(output).not.toContain(TOKEN);
  });

  it('fails before invoking the trial when a valid CLI request has no Discord token', async () => {
    let calls = 0;
    let output = '';
    const code = await main({
      argv: [
        '--release',
        RELEASE,
        '--run-id',
        RUN_ID,
        '--trial-id',
        TRIAL_ID,
        '--host-version',
        '2.1.228',
        '--source-commit',
        'a'.repeat(40),
        '--guild',
        GUILD_ID,
        '--confirmation',
        `${CLAUDE_CODE_ACTIVATION_CONFIRMATION_PREFIX}${RELEASE}:${TRIAL_ID}`,
        '--write-approval',
        `${CLAUDE_CODE_ACTIVATION_WRITE_CONFIRMATION_PREFIX}${RELEASE}:${TRIAL_ID}`,
      ],
      environment: {},
      stdout: { write: (value) => (output += value) },
      runTrial: async () => {
        calls += 1;
        return { ok: true };
      },
    });

    expect(code).toBe(1);
    expect(calls).toBe(0);
    expect(JSON.parse(output)).toEqual({
      schema_version: 'discord-mcp.claude-code-activation-cli.v1',
      ok: false,
      error: 'Claude Code activation trial failed',
    });
  });

  it('maps a failed trial to a nonzero CLI exit without exposing its artifact', async () => {
    let output = '';
    const code = await main({
      argv: [
        '--release',
        RELEASE,
        '--run-id',
        RUN_ID,
        '--trial-id',
        TRIAL_ID,
        '--host-version',
        '2.1.228',
        '--source-commit',
        'a'.repeat(40),
        '--guild',
        GUILD_ID,
        '--confirmation',
        `${CLAUDE_CODE_ACTIVATION_CONFIRMATION_PREFIX}${RELEASE}:${TRIAL_ID}`,
        '--write-approval',
        `${CLAUDE_CODE_ACTIVATION_WRITE_CONFIRMATION_PREFIX}${RELEASE}:${TRIAL_ID}`,
      ],
      environment: { DISCORD_TESTBOT_B_TOKEN: `Bot ${TOKEN}` },
      stdout: { write: (value) => (output += value) },
      runTrial: async () => ({ ok: false, artifact: { token: TOKEN } }),
    });

    expect(code).toBe(1);
    expect(JSON.parse(output)).toEqual({
      schema_version: 'discord-mcp.claude-code-activation-cli.v1',
      ok: false,
      error: 'Claude Code activation trial failed',
    });
    expect(output).not.toContain(TOKEN);
  });

  it('rejects duplicate, unknown, incomplete, and uncontrolled CLI arguments', () => {
    const complete = [
      '--release',
      RELEASE,
      '--run-id',
      RUN_ID,
      '--trial-id',
      TRIAL_ID,
      '--host-version',
      '2.1.228',
      '--source-commit',
      'a'.repeat(40),
      '--guild',
      GUILD_ID,
      '--confirmation',
      `${CLAUDE_CODE_ACTIVATION_CONFIRMATION_PREFIX}${RELEASE}:${TRIAL_ID}`,
      '--write-approval',
      `${CLAUDE_CODE_ACTIVATION_WRITE_CONFIRMATION_PREFIX}${RELEASE}:${TRIAL_ID}`,
    ];
    expect(() => parseClaudeCodeActivationArgs(complete.slice(0, -2))).toThrow(/invalid/);
    expect(() => parseClaudeCodeActivationArgs([...complete, '--release', RELEASE])).toThrow(
      /invalid/,
    );
    expect(() => parseClaudeCodeActivationArgs([...complete, '--unknown', 'value'])).toThrow(
      /invalid/,
    );
    const guildIndex = complete.indexOf('--guild') + 1;
    const uncontrolled = [...complete];
    uncontrolled[guildIndex] = '1533719084636700999';
    expect(() => parseClaudeCodeActivationArgs(uncontrolled)).toThrow(/invalid/);
  });
});
