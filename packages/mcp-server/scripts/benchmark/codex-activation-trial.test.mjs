import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonicalActivationAttestationDigest } from './activation-attestation.mjs';
import {
  buildCodexSetupArgs,
  CODEX_ACTIVATION_CONFIRMATION_PREFIX,
  CODEX_ACTIVATION_WRITE_CONFIRMATION_PREFIX,
  createDefaultCodexActivationDependencies,
  runCodexActivationTrial,
} from './codex-activation-trial.mjs';
import { NPM_REGISTRY_URL } from './npm-provenance.mjs';

const RELEASE = '0.22.0';
const RUN_ID = 'activation-run-001';
const TRIAL = 'trial-001';
const TARGET = {
  guildId: '1537332825978568744',
  botId: '1537332825978568745',
  controlled: true,
  callerOwned: true,
};
const DIGEST = (character) => `sha256:${character.repeat(64)}`;
const CONFIG = `command = "npx"\nargs = ["--yes", "@discord-mcp/cli@${RELEASE}"]\nstartup_timeout_sec = 90\ntool_timeout_sec = 180\nenv_vars = ["DISCORD_TOKEN"]\n`;

function request(overrides = {}) {
  return {
    release: RELEASE,
    runId: RUN_ID,
    hostVersion: '0.147.0',
    sourceCommit: 'a'.repeat(40),
    trialId: TRIAL,
    target: TARGET,
    token: 'token-never-in-artifact',
    executionMode: 'test',
    operatorConfirmation: `${CODEX_ACTIVATION_CONFIRMATION_PREFIX}${RELEASE}:${TRIAL}`,
    writeApproval: `${CODEX_ACTIVATION_WRITE_CONFIRMATION_PREFIX}${RELEASE}:${TRIAL}`,
    dependencies: fakeDependencies(),
    clock: {
      now: (() => {
        let time = 0;
        return () => time++;
      })(),
    },
    ...overrides,
  };
}

function fakeDependencies(overrides = {}) {
  const calls = [];
  const targetBinding = { binding: TARGET };
  const dependencies = {
    calls,
    persisted: null,
    executionProvenance: {
      execution_mode: 'test',
      adapter_id: 'codex-test-fixture',
      abortable: true,
      package_source: 'test_fixture',
    },
    workspace: {
      async create() {
        calls.push('workspace.create');
        return {
          root: 'temp-root',
          home: 'temp-home',
          installRoot: 'install-root',
          profileRoot: 'profile-root',
          configPath: 'config.toml',
          cleanProfile: true,
        };
      },
      async readText() {
        calls.push('workspace.readText');
        return CONFIG;
      },
      async writeText() {
        calls.push('workspace.writeText');
      },
      async remove() {
        calls.push('workspace.remove');
        return { removed: true, verified: true };
      },
    },
    async captureBaseline() {
      calls.push('captureBaseline');
      return { beforeDigest: DIGEST('a') };
    },
    async install() {
      calls.push('install');
      return {
        packageSpec: `@discord-mcp/cli@${RELEASE}`,
        sourceCommit: 'a'.repeat(40),
        cliDigest: DIGEST('b'),
        coreDigest: DIGEST('c'),
        packageDigest: DIGEST('d'),
      };
    },
    async setup() {
      calls.push('setup');
      return {
        exitCode: 0,
        config: CONFIG,
        administratorWarning: false,
        binding: { guildId: TARGET.guildId, botId: TARGET.botId },
        bindingVerified: true,
      };
    },
    async enableWrites() {
      calls.push('enableWrites');
      return { config: `${CONFIG}\nMCP_DRY_RUN = "false"\nMCP_WRITE_MODE = "allow"\n` };
    },
    async launch() {
      calls.push('launch');
      return {
        ...targetBinding,
        clientReady: true,
        firstRequest: true,
        isolated: true,
        launcherDigest: DIGEST('e'),
        sessionDigest: DIGEST('c'),
      };
    },
    async closeSession() {
      calls.push('closeSession');
      return { settled: true };
    },
    async apply() {
      calls.push('apply');
      return { ...targetBinding, status: 'complete' };
    },
    async evidence() {
      calls.push('evidence');
      return {
        ...targetBinding,
        status: 'verified',
        activityEvidence: {
          schema_version: 'guild_blueprint_activity_evidence.v1',
          status: 'verified',
          evidence_id: DIGEST('9'),
          target: { guild_id: TARGET.guildId, bot_id: TARGET.botId },
        },
      };
    },
    async restoreBaseline() {
      calls.push('restoreBaseline');
      return { afterDigest: DIGEST('a') };
    },
    async verifyBaseline() {
      calls.push('verifyBaseline');
      return { restored: true, exact: true, afterDigest: DIGEST('a') };
    },
    async validateActivityEvidence() {
      calls.push('validateActivityEvidence');
      return true;
    },
    async persistAttestation({ attestation, digest }) {
      calls.push('persistAttestation');
      dependencies.persisted = { attestation, digest };
      return { persisted: true, digest };
    },
    ...overrides,
  };
  return dependencies;
}

describe('Codex activation trial seam', () => {
  it('rejects missing execution provenance before creating a workspace', async () => {
    const dependencies = fakeDependencies({ executionProvenance: undefined });
    await expect(runCodexActivationTrial(request({ dependencies }))).rejects.toThrow(
      /executionProvenance is required/,
    );
    expect(dependencies.calls).toEqual([]);
  });

  it('does not let an injected dependency claim authoritative live execution', async () => {
    const dependencies = fakeDependencies({
      executionProvenance: {
        execution_mode: 'live',
        adapter_id: 'discord-mcp.codex-activation.v1',
        abortable: true,
        package_source: 'verified_npm_provenance',
      },
    });
    await expect(
      runCodexActivationTrial(request({ dependencies, executionMode: 'live' })),
    ).rejects.toThrow(/built-in audited dependency adapter/);
    expect(dependencies.calls).toEqual([]);
  });

  it('requires an explicit lifecycle close seam for live execution', async () => {
    const dependencies = fakeDependencies({
      closeSession: undefined,
      terminate: undefined,
      executionProvenance: {
        execution_mode: 'live',
        adapter_id: 'discord-mcp.codex-activation.v1',
        abortable: true,
        package_source: 'verified_npm_provenance',
      },
    });
    await expect(
      runCodexActivationTrial(request({ dependencies, executionMode: 'live' })),
    ).rejects.toThrow(/closeSession or terminate lifecycle seam/);
    expect(dependencies.calls).toEqual([]);
  });

  it('does not allow the library boundary to relax the ten-minute SLA', async () => {
    const dependencies = fakeDependencies();
    await expect(
      runCodexActivationTrial(request({ dependencies, maxDurationMs: 600_001 })),
    ).rejects.toThrow(/between 1 and 600000/);
    expect(dependencies.calls).toEqual([]);
  });

  it('runs the clean activation order and emits a passing artifact only after evidence and restore', async () => {
    const dependencies = fakeDependencies();
    const result = await runCodexActivationTrial(request({ dependencies }));
    expect(result.ok).toBe(true);
    expect(result.artifact.result).toBe('passed');
    expect(result.artifact.evidence).toEqual({
      apply: 'completed',
      guild_blueprint_evidence: 'verified',
    });
    expect(result.artifact.baseline).toMatchObject({ restored: true, exact: true });
    expect(dependencies.persisted).not.toBeNull();
    expect(dependencies.persisted.digest).toBe(
      canonicalActivationAttestationDigest(dependencies.persisted.attestation),
    );
    expect(dependencies.persisted.attestation.binding).toEqual({
      guild_id: TARGET.guildId,
      bot_id: TARGET.botId,
    });
    expect(dependencies.calls).toEqual([
      'workspace.create',
      'captureBaseline',
      'install',
      'setup',
      'enableWrites',
      'launch',
      'apply',
      'evidence',
      'validateActivityEvidence',
      'closeSession',
      'restoreBaseline',
      'verifyBaseline',
      'workspace.remove',
      'persistAttestation',
    ]);
    expect(JSON.stringify(result.artifact)).not.toContain('token-never-in-artifact');
    expect(JSON.stringify(result.artifact)).not.toMatch(/153733282597856874[45]/);
  });

  it('preserves the platform profile environment fallback for custom workspaces', async () => {
    let observedSetupProfileEnvironmentKey;
    let observedLaunchProfileEnvironmentKey;
    const dependencies = fakeDependencies({
      async setup(args) {
        dependencies.calls.push('setup');
        observedSetupProfileEnvironmentKey = args.profileEnvironmentKey;
        return {
          exitCode: 0,
          config: CONFIG,
          administratorWarning: false,
          binding: { guildId: TARGET.guildId, botId: TARGET.botId },
          bindingVerified: true,
        };
      },
      async launch(args) {
        dependencies.calls.push('launch');
        observedLaunchProfileEnvironmentKey = args.profileEnvironmentKey;
        return {
          binding: TARGET,
          clientReady: true,
          firstRequest: true,
          isolated: true,
          launcherDigest: DIGEST('e'),
          sessionDigest: DIGEST('c'),
        };
      },
    });

    const result = await runCodexActivationTrial(request({ dependencies }));

    expect(result.ok).toBe(true);
    const expected = process.platform === 'win32' ? 'APPDATA' : 'XDG_CONFIG_HOME';
    expect(observedSetupProfileEnvironmentKey).toBe(expected);
    expect(observedLaunchProfileEnvironmentKey).toBe(expected);
  });

  it('normalizes one optional Bot prefix before every dependency boundary', async () => {
    let observedSetupToken;
    let observedLaunchToken;
    const dependencies = fakeDependencies({
      async setup(args) {
        dependencies.calls.push('setup');
        observedSetupToken = args.token;
        return {
          exitCode: 0,
          config: CONFIG,
          administratorWarning: false,
          binding: { guildId: TARGET.guildId, botId: TARGET.botId },
          bindingVerified: true,
        };
      },
      async launch(args) {
        dependencies.calls.push('launch');
        observedLaunchToken = args.env.DISCORD_TOKEN;
        return {
          binding: TARGET,
          clientReady: true,
          firstRequest: true,
          isolated: true,
          launcherDigest: DIGEST('e'),
          sessionDigest: DIGEST('c'),
        };
      },
    });
    const result = await runCodexActivationTrial(request({ token: 'Bot raw-token', dependencies }));
    expect(result.ok).toBe(true);
    expect(observedSetupToken).toBe('raw-token');
    expect(observedLaunchToken).toBe('raw-token');
  });

  it('requires guided setup JSON to prove the bot and guild binding', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-setup-test-'));
    try {
      const configPath = join(root, 'config.toml');
      await writeFile(configPath, CONFIG);
      const dependencies = createDefaultCodexActivationDependencies({
        runCommand: async (_command, args, options) => {
          expect(args.slice(1)).toEqual(
            buildCodexSetupArgs({
              profile: 'activation-trial-001',
              guildId: TARGET.guildId,
              configPath,
            }),
          );
          expect(options).toMatchObject({
            timeout: 180_000,
            maxBuffer: 10 * 1024 * 1024,
            windowsHide: true,
          });
          return {
            code: 0,
            stdout: JSON.stringify({
              ok: true,
              exitCode: 0,
              data: {
                allowedGuilds: [TARGET.guildId],
                discord: { bot: { id: TARGET.botId } },
              },
            }),
          };
        },
      });
      const setup = await dependencies.setup({
        release: RELEASE,
        profile: 'activation-trial-001',
        target: TARGET,
        configPath,
        home: root,
        profileRoot: root,
        installRoot: root,
        token: 'raw-token',
      });
      expect(setup.bindingVerified).toBe(true);
      expect(setup.binding).toEqual({ guildId: TARGET.guildId, botId: TARGET.botId });

      const tooBroad = createDefaultCodexActivationDependencies({
        runCommand: async () => ({
          code: 0,
          stdout: JSON.stringify({
            ok: true,
            exitCode: 0,
            data: {
              allowedGuilds: [TARGET.guildId, '1533719084636700775'],
              discord: { bot: { id: TARGET.botId } },
            },
          }),
        }),
      });
      await expect(
        tooBroad.setup({
          release: RELEASE,
          profile: 'activation-trial-001',
          target: TARGET,
          configPath,
          home: root,
          profileRoot: root,
          installRoot: root,
          token: 'raw-token',
        }),
      ).rejects.toThrow(/exactly match/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('runs auth preflight before workspace or Discord baseline side effects', async () => {
    const dependencies = fakeDependencies();
    await expect(
      runCodexActivationTrial(
        request({
          dependencies,
          authPreflight: async () => {
            throw new Error('authentication is unavailable');
          },
        }),
      ),
    ).rejects.toThrow('authentication is unavailable');
    expect(dependencies.calls).toEqual([]);
  });

  it('does not brand a factory with injected seams as authoritative live execution', async () => {
    let commandCalled = false;
    const dependencies = createDefaultCodexActivationDependencies({
      runCommand: async () => {
        commandCalled = true;
        return { code: 0 };
      },
    });
    await expect(
      runCodexActivationTrial(request({ dependencies, executionMode: 'live' })),
    ).rejects.toThrow(/built-in audited dependency adapter/);
    expect(commandCalled).toBe(false);
  });

  it('rejects inherited activation seams before branding or command execution', () => {
    let commandCalled = false;
    const inherited = Object.create({
      runCommand: async () => {
        commandCalled = true;
        return { code: 0 };
      },
      environment: { PATH: process.env.PATH },
      resolveNpmCli: async () => 'injected-npm-cli.js',
    });
    expect(() => createDefaultCodexActivationDependencies(inherited)).toThrow(
      /must not inherit activation seams/,
    );
    expect(commandCalled).toBe(false);
  });

  it('does not brand a proxy-hidden activation seam as trusted', async () => {
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
    const dependencies = createDefaultCodexActivationDependencies(options);
    await expect(
      runCodexActivationTrial(request({ dependencies, executionMode: 'live' })),
    ).rejects.toThrow(/built-in audited dependency adapter/);
    expect(commandCalled).toBe(false);
  });

  it('does not accept a launch binding when guided setup proof is wrong', async () => {
    const dependencies = fakeDependencies({
      async setup() {
        dependencies.calls.push('setup');
        return {
          exitCode: 0,
          config: CONFIG,
          administratorWarning: false,
          binding: { guildId: TARGET.guildId, botId: '1537332825978568746' },
          bindingVerified: true,
        };
      },
    });
    const result = await runCodexActivationTrial(request({ dependencies }));
    expect(result.ok).toBe(false);
    expect(dependencies.calls).not.toContain('launch');
    expect(dependencies.calls).toContain('restoreBaseline');
  });

  it('requires a separate verified evidence result and still restores after its absence', async () => {
    const dependencies = fakeDependencies({
      async evidence() {
        dependencies.calls.push('evidence');
        return undefined;
      },
    });
    const result = await runCodexActivationTrial(request({ dependencies }));
    expect(result.ok).toBe(false);
    expect(result.artifact.result).toBe('failed');
    expect(dependencies.calls).toContain('restoreBaseline');
    expect(result.artifact.evidence.guild_blueprint_evidence).not.toBe('verified');
  });

  it('does not restore or remove after a failed session close', async () => {
    const dependencies = fakeDependencies({
      async closeSession() {
        dependencies.calls.push('closeSession');
        throw new Error('close failed');
      },
    });
    const result = await runCodexActivationTrial(request({ dependencies }));
    expect(result.ok).toBe(false);
    expect(dependencies.calls).toContain('closeSession');
    expect(dependencies.calls).not.toContain('restoreBaseline');
    expect(dependencies.calls).not.toContain('workspace.remove');
  });

  it('requires explicit proof that the session lifecycle settled', async () => {
    const dependencies = fakeDependencies({
      async closeSession() {
        dependencies.calls.push('closeSession');
        return undefined;
      },
    });
    const result = await runCodexActivationTrial(request({ dependencies }));
    expect(result.ok).toBe(false);
    expect(dependencies.calls).toContain('closeSession');
    expect(dependencies.calls).not.toContain('restoreBaseline');
    expect(dependencies.calls).not.toContain('workspace.remove');
  });

  it('quarantines an unregistered launch failure instead of racing cleanup', async () => {
    const dependencies = fakeDependencies({
      async launch() {
        dependencies.calls.push('launch');
        throw new Error('launch failed before returning a handle');
      },
    });
    const result = await runCodexActivationTrial(request({ dependencies }));
    expect(result.ok).toBe(false);
    expect(dependencies.calls).not.toContain('closeSession');
    expect(dependencies.calls).not.toContain('restoreBaseline');
    expect(dependencies.calls).not.toContain('workspace.remove');
  });

  it('closes an early-registered session before recovering from launch failure', async () => {
    const dependencies = fakeDependencies({
      async launch({ registerSession }) {
        dependencies.calls.push('launch');
        registerSession({ processId: 123 });
        throw new Error('launch failed after starting the client');
      },
    });
    const result = await runCodexActivationTrial(request({ dependencies }));
    expect(result.ok).toBe(false);
    expect(dependencies.calls.indexOf('closeSession')).toBeLessThan(
      dependencies.calls.indexOf('restoreBaseline'),
    );
    expect(dependencies.calls).toContain('workspace.remove');
  });

  it.each([
    ['missing', undefined],
    ['malformed', 'sha256:bad'],
  ])('rejects a %s session digest from the launched client', async (_label, sessionDigest) => {
    const dependencies = fakeDependencies({
      async launch() {
        dependencies.calls.push('launch');
        return {
          binding: TARGET,
          clientReady: true,
          firstRequest: true,
          isolated: true,
          ...(sessionDigest === undefined ? {} : { sessionDigest }),
        };
      },
    });
    const result = await runCodexActivationTrial(request({ dependencies }));
    expect(result.ok).toBe(false);
    expect(result.artifact.digests.session).not.toBe(DIGEST('c'));
    expect(dependencies.calls).not.toContain('apply');
  });

  it('requires the installed packages to prove the exact requested source commit', async () => {
    const dependencies = fakeDependencies({
      async install() {
        dependencies.calls.push('install');
        return {
          sourceCommit: 'b'.repeat(40),
          cliDigest: DIGEST('b'),
          coreDigest: DIGEST('c'),
          packageDigest: DIGEST('d'),
        };
      },
    });
    const result = await runCodexActivationTrial(request({ dependencies }));
    expect(result.ok).toBe(false);
    expect(dependencies.calls).not.toContain('setup');
    expect(dependencies.calls).toContain('restoreBaseline');
  });

  it('does not restore against an uncaptured baseline', async () => {
    const dependencies = fakeDependencies({
      async captureBaseline() {
        dependencies.calls.push('captureBaseline');
        return null;
      },
    });
    const result = await runCodexActivationTrial(request({ dependencies }));
    expect(result.ok).toBe(false);
    expect(dependencies.calls).not.toContain('restoreBaseline');
    expect(dependencies.calls).toContain('workspace.remove');
  });

  it('cannot pass without attestation persistence', async () => {
    const dependencies = fakeDependencies({ persistAttestation: undefined });
    const result = await runCodexActivationTrial(request({ dependencies }));
    expect(result.ok).toBe(false);
    expect(result.artifact.result).toBe('failed');
  });

  it('rejects tampered Activity Evidence target binding', async () => {
    const dependencies = fakeDependencies({
      async evidence() {
        dependencies.calls.push('evidence');
        return {
          ...{ binding: TARGET },
          status: 'verified',
          activityEvidence: {
            schema_version: 'guild_blueprint_activity_evidence.v1',
            status: 'verified',
            evidence_id: DIGEST('9'),
            target: { guild_id: TARGET.guildId, bot_id: '1537332825978568746' },
          },
        };
      },
    });
    const result = await runCodexActivationTrial(request({ dependencies }));
    expect(result.ok).toBe(false);
    expect(dependencies.calls).toContain('restoreBaseline');
  });

  it('does not infer cleanup from a failed or unverifiable workspace removal', async () => {
    const dependencies = fakeDependencies({
      workspace: {
        ...fakeDependencies().workspace,
        async create() {
          dependencies.calls.push('workspace.create');
          return {
            root: 'temp-root',
            home: 'temp-home',
            installRoot: 'install-root',
            profileRoot: 'profile-root',
            configPath: 'config.toml',
            cleanProfile: false,
          };
        },
        async remove() {
          dependencies.calls.push('workspace.remove');
          return { removed: false, verified: false };
        },
      },
    });
    const result = await runCodexActivationTrial(request({ dependencies }));
    expect(result.ok).toBe(false);
    expect(result.artifact.safety.clean_profile).toBe(false);
  });

  it('does not let cleanup verification replace missing creation proof', async () => {
    const dependencies = fakeDependencies({
      workspace: {
        ...fakeDependencies().workspace,
        async create() {
          dependencies.calls.push('workspace.create');
          return {
            root: 'temp-root',
            home: 'temp-home',
            installRoot: 'install-root',
            profileRoot: 'profile-root',
            configPath: 'config.toml',
            cleanProfile: false,
          };
        },
      },
    });
    const result = await runCodexActivationTrial(request({ dependencies }));
    expect(result.ok).toBe(false);
    expect(result.artifact.safety.clean_profile).toBe(false);
  });

  it('hashes installed package bytes through the default install adapter', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-install-test-'));
    try {
      await mkdir(join(root, 'node_modules', '@discord-mcp', 'cli', 'dist'), { recursive: true });
      await mkdir(join(root, 'node_modules', '@discord-mcp', 'core', 'dist'), { recursive: true });
      await writeFile(join(root, 'node_modules', '@discord-mcp', 'cli', 'dist', 'cli.js'), 'cli-a');
      await writeFile(
        join(root, 'node_modules', '@discord-mcp', 'core', 'dist', 'core.js'),
        'core-a',
      );
      await writeFile(join(root, 'package-lock.json'), '{"lockfileVersion":3}');
      const commands = [];
      const provenanceChecks = [];
      const dependencies = createDefaultCodexActivationDependencies({
        resolveNpmCli: async () => join(dirname(process.execPath), 'npm-cli.js'),
        runCommand: async (command, args, options) => {
          commands.push({ command, args, options });
          return { code: 0 };
        },
        environment: {
          Path: 'safe-path',
          TEMP: 'safe-temp',
          DISCORD_TOKEN: 'must-not-reach-npm',
          MCP_WRITE_MODE: 'allow',
          OPENAI_API_KEY: 'must-not-reach-npm',
        },
        verifyProvenance: async ({ packageName, expectedCommit, signal, env }) => {
          provenanceChecks.push({ packageName, expectedCommit, signal, env });
          return {
            sourceCommit: expectedCommit,
            registryIntegrityDigest: `sha512-${Buffer.from(packageName).toString('base64')}`,
          };
        },
      });
      const sourceCommit = 'a'.repeat(40);
      const installed = await dependencies.install({
        release: RELEASE,
        sourceCommit,
        installRoot: root,
      });
      expect(commands[0].command).toBe(process.execPath);
      expect(commands[0].args[0]).toBe(join(dirname(process.execPath), 'npm-cli.js'));
      expect(commands[0].args).toContain(`--registry=${NPM_REGISTRY_URL}`);
      expect(commands[0].args).toContain(`@discord-mcp/cli@${RELEASE}`);
      expect(commands[0].options.env).toEqual({
        TEMP: 'safe-temp',
        [process.platform === 'win32' ? 'Path' : 'PATH']: dirname(process.execPath),
      });
      expect(provenanceChecks.map(({ packageName }) => packageName)).toEqual([
        '@discord-mcp/cli',
        '@discord-mcp/core',
      ]);
      expect(provenanceChecks.every(({ expectedCommit }) => expectedCommit === sourceCommit)).toBe(
        true,
      );
      expect(provenanceChecks.every(({ env }) => env.DISCORD_TOKEN === undefined)).toBe(true);
      expect(installed.sourceCommit).toBe(sourceCommit);
      expect(installed.cliDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(installed.coreDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(installed.packageDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(installed.packageDigest).not.toBe(DIGEST('x'));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('treats an Administrator warning as a safety failure and never enables writes', async () => {
    const dependencies = fakeDependencies({
      async setup() {
        dependencies.calls.push('setup');
        return { exitCode: 1, config: CONFIG, administratorWarning: true };
      },
    });
    const result = await runCodexActivationTrial(request({ dependencies }));
    expect(result.ok).toBe(false);
    expect(result.artifact.safety.dangerous_permissions).toBe(true);
    expect(dependencies.calls).not.toContain('enableWrites');
    expect(dependencies.calls).toContain('restoreBaseline');
  });

  it.each([
    [
      'install',
      {
        async install() {
          throw new Error('install');
        },
      },
    ],
    [
      'setup',
      {
        async setup() {
          throw new Error('setup');
        },
      },
    ],
  ])('fails safely for pre-session %s errors and attempts exact restore', async (_name, override) => {
    const dependencies = fakeDependencies(override);
    const result = await runCodexActivationTrial(request({ dependencies }));
    expect(result.ok).toBe(false);
    expect(result.artifact.result).toBe('failed');
    expect(dependencies.calls).toContain('restoreBaseline');
    expect(dependencies.calls).toContain('verifyBaseline');
  });

  it('fails at the strict timeout boundary and does not emit a pass', async () => {
    let time = 0;
    const timeout = await runCodexActivationTrial(
      request({ maxDurationMs: 1, clock: { now: () => (time++ === 0 ? 0 : 1) } }),
    );
    expect(timeout.ok).toBe(false);
    expect(timeout.artifact.terminal_status).toBe('timeout');
  });

  it('keeps a recovery signal usable after the activation SLA expires', async () => {
    let restoreSignal;
    let time = 0;
    const dependencies = fakeDependencies({
      async restoreBaseline(args) {
        dependencies.calls.push('restoreBaseline');
        restoreSignal = args.signal;
        return { afterDigest: DIGEST('a') };
      },
    });
    const timeout = await runCodexActivationTrial(
      request({
        dependencies,
        maxDurationMs: 1,
        clock: { now: () => time++ },
      }),
    );
    expect(timeout.ok).toBe(false);
    expect(timeout.artifact.terminal_status).toBe('timeout');
    expect(restoreSignal).toBeDefined();
    expect(restoreSignal.aborted).toBe(false);
  });

  it.each([
    ['restored proof', { exact: true, afterDigest: DIGEST('a') }],
    ['readback digest', { exact: true, restored: true }],
  ])('cannot attest an exact baseline without %s', async (_label, verification) => {
    const dependencies = fakeDependencies({
      async verifyBaseline() {
        dependencies.calls.push('verifyBaseline');
        return verification;
      },
    });
    const result = await runCodexActivationTrial(request({ dependencies }));
    expect(result.ok).toBe(false);
    expect(result.artifact.baseline).toMatchObject({ restored: false, exact: false });
  });

  it('waits for a timed-out operation to settle before restoring the baseline', async () => {
    const order = [];
    const dependencies = fakeDependencies({
      async install() {
        dependencies.calls.push('install');
        await new Promise((resolve) => setTimeout(resolve, 20));
        order.push('install-settled');
        return {
          sourceCommit: 'a'.repeat(40),
          cliDigest: DIGEST('b'),
          coreDigest: DIGEST('c'),
          packageDigest: DIGEST('d'),
        };
      },
      async restoreBaseline() {
        dependencies.calls.push('restoreBaseline');
        order.push('restore');
        return { afterDigest: DIGEST('a') };
      },
    });
    const result = await runCodexActivationTrial(
      request({ dependencies, maxDurationMs: 5, clock: undefined }),
    );
    expect(result.ok).toBe(false);
    expect(result.artifact.terminal_status).toBe('timeout');
    expect(order).toEqual(['install-settled', 'restore']);
  });

  it('does not restore or remove when an aborted operation ignores cancellation grace', async () => {
    const dependencies = fakeDependencies({
      async install() {
        dependencies.calls.push('install');
        await new Promise(() => {});
      },
    });
    const result = await runCodexActivationTrial(
      request({ dependencies, maxDurationMs: 5, clock: undefined }),
    );
    expect(result.ok).toBe(false);
    expect(result.artifact.terminal_status).toBe('timeout');
    expect(dependencies.calls).not.toContain('closeSession');
    expect(dependencies.calls).not.toContain('restoreBaseline');
    expect(dependencies.calls).not.toContain('workspace.remove');
  });
});
