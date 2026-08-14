import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  __private,
  createNpmAuditEnvironment,
  EXPECTED_SOURCE_REPOSITORY,
  NPM_REGISTRY_URL,
  resolveTrustedNpmCli,
  verifyInstalledNpmProvenance,
} from './npm-provenance.mjs';

const RELEASE = '0.22.0';
const COMMIT = 'a'.repeat(40);
const PACKAGE = '@discord-mcp/cli';
const PACKAGE_PURL = 'pkg:npm/%40discord-mcp/cli@0.22.0';
const ARTIFACT_BYTES = Buffer.from('published-cli-artifact');
const INTEGRITY = `sha512-${createHash('sha512').update(ARTIFACT_BYTES).digest('base64')}`;
const ATTESTATION_URL = `https://registry.npmjs.org/-/npm/v1/attestations/@discord-mcp/cli@${RELEASE}`;
const NODE_EXECUTABLE = 'C:/trusted-node/node.exe';
const NPM_CLI = 'C:/trusted-node/node_modules/npm/bin/npm-cli.js';

function statement({
  subjectName = PACKAGE_PURL,
  subjectDigest = INTEGRITY.slice('sha512-'.length),
  repository = EXPECTED_SOURCE_REPOSITORY,
  commit = COMMIT,
  duplicateSource = false,
} = {}) {
  const source = {
    uri: `git+https://${repository}.git@${commit}`,
    digest: { gitCommit: commit },
  };
  return {
    _type: 'https://in-toto.io/Statement/v1',
    subject: [{ name: subjectName, digest: { sha512: subjectDigest } }],
    predicateType: 'https://slsa.dev/provenance/v1',
    predicate: {
      buildDefinition: {
        resolvedDependencies: duplicateSource ? [source, structuredClone(source)] : [source],
      },
    },
  };
}

function attestation(value = {}) {
  const payload = Buffer.from(JSON.stringify(statement(value))).toString('base64');
  return {
    attestations: [
      {
        predicateType: 'https://slsa.dev/provenance/v1',
        bundle: {
          dsseEnvelope: {
            payloadType: 'application/vnd.in-toto+json',
            payload,
            signatures: [{ keyid: 'npm', sig: 'verified-by-npm-audit' }],
          },
        },
      },
    ],
  };
}

function metadata({ integrity = INTEGRITY, url = ATTESTATION_URL } = {}) {
  return {
    name: PACKAGE,
    versions: {
      [RELEASE]: { name: PACKAGE, version: RELEASE, dist: { integrity, attestations: { url } } },
    },
  };
}

function harness({
  audit = { invalid: [], missing: [] },
  registry = metadata(),
  provenance = attestation(),
  ...options
} = {}) {
  const calls = [];
  const runCommand = async (command, args, commandOptions) => {
    calls.push({ command, args, options: commandOptions });
    if (options.commandResult) return options.commandResult;
    return { code: 0, stdout: JSON.stringify(audit), stderr: '' };
  };
  const fetchJson = async (url) => {
    if (url.includes('/-/npm/v1/attestations/')) return provenance;
    return registry;
  };
  return { calls, runCommand, fetchJson };
}

async function verify(options = {}) {
  const setup = harness(options);
  const result = await verifyInstalledNpmProvenance({
    installRoot: 'C:/activation-install',
    packageName: PACKAGE,
    release: RELEASE,
    expectedCommit: COMMIT,
    platform: 'win32',
    nodeExecPath: NODE_EXECUTABLE,
    resolveNpmCli: async () => NPM_CLI,
    env: {
      Path: 'C:/node',
      SystemRoot: 'C:/Windows',
      ComSpec: 'C:/Windows/System32/cmd.exe',
      TEMP: 'C:/Temp',
      DISCORD_TOKEN: 'bot-token-must-not-cross-boundary',
      DISCORD_TESTBOT_B_TOKEN: 'second-token-must-not-cross-boundary',
      MCP_WRITE_MODE: 'allow',
      OPENAI_API_KEY: 'api-key-must-not-cross-boundary',
      HTTPS_PROXY: 'https://proxy.example.test:443',
      npm_config_cache: 'C:/npm-cache',
    },
    ...options,
    runCommand: setup.runCommand,
    fetchJson: setup.fetchJson,
    readLockfile:
      options.readLockfile ??
      (async () => ({
        lockfileVersion: 3,
        packages: {
          [`node_modules/${PACKAGE}`]: { version: RELEASE, integrity: INTEGRITY },
        },
      })),
  });
  return { result, calls: setup.calls };
}

describe('npm provenance gate', () => {
  it('runs the exact npm audit signature command with a secret-free environment', async () => {
    const controller = new AbortController();
    const { result, calls } = await verify({ signal: controller.signal });
    expect(result).toEqual({ sourceCommit: COMMIT, registryIntegrityDigest: INTEGRITY });
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe(NODE_EXECUTABLE);
    expect(calls[0].args).toEqual([
      NPM_CLI,
      'audit',
      'signatures',
      '--json',
      `--registry=${NPM_REGISTRY_URL}`,
    ]);
    expect(calls[0].options.cwd).toBe('C:/activation-install');
    expect(calls[0].options.timeout).toBe(120_000);
    expect(calls[0].options.signal).toBe(controller.signal);
    expect(calls[0].options.env).toMatchObject({
      Path: 'C:/trusted-node',
      SystemRoot: 'C:/Windows',
      TEMP: 'C:/Temp',
      HTTPS_PROXY: 'https://proxy.example.test:443',
      npm_config_cache: 'C:/npm-cache',
    });
    expect(Object.keys(calls[0].options.env)).not.toEqual(
      expect.arrayContaining([
        'DISCORD_TOKEN',
        'DISCORD_TESTBOT_B_TOKEN',
        'MCP_WRITE_MODE',
        'OPENAI_API_KEY',
      ]),
    );
    expect(JSON.stringify(calls[0].options.env)).not.toContain('token');
  });

  it('allows only safe registry subprocess environment variables', () => {
    expect(
      createNpmAuditEnvironment({
        env: {
          PATH: '/bin',
          npm_config_registry: 'https://registry.npmjs.org',
          npm_config_cache: '/tmp/npm',
          HTTP_PROXY: 'http://user:password@proxy.example.test',
          MCP_DRY_RUN: 'false',
          DISCORD_TOKEN: 'token-value',
          NODE_AUTH_TOKEN: 'auth-value',
          NODE_EXTRA_CA_CERTS: '/attacker/root.pem',
          npm_config_cafile: '/attacker/npm.pem',
          SSL_CERT_FILE: '/attacker/ssl.pem',
          SSL_CERT_DIR: '/attacker/certs',
          RANDOM_VALUE: 'no',
        },
        nodeExecPath: '/trusted/node',
        platform: 'linux',
      }),
    ).toEqual({
      npm_config_cache: '/tmp/npm',
      PATH: '/trusted',
    });
  });

  it('does not allow hostile PATH or ComSpec to select the npm executable', async () => {
    const { calls } = await verify({
      env: {
        Path: 'C:/attacker',
        ComSpec: 'C:/attacker/cmd.exe',
        SystemRoot: 'C:/Windows',
      },
    });
    expect(calls[0].command).toBe(NODE_EXECUTABLE);
    expect(calls[0].args[0]).toBe(NPM_CLI);
    expect(calls[0].options.env.Path).toBe('C:/trusted-node');
    expect(calls[0].options.env.ComSpec).toBeUndefined();
  });

  it.each([
    [
      'non-zero npm exit',
      { commandResult: { code: 1, stdout: JSON.stringify({ invalid: [], missing: [] }) } },
      /exited unsuccessfully/,
    ],
    ['invalid signatures', { audit: { invalid: ['cli'], missing: [] } }, /missing or invalid/],
    ['missing signatures', { audit: { invalid: [], missing: ['cli'] } }, /missing or invalid/],
    ['missing audit fields', { audit: {} }, /incomplete results/],
    [
      'malformed DSSE payload',
      {
        provenance: {
          attestations: [
            {
              predicateType: 'https://slsa.dev/provenance/v1',
              bundle: {
                dsseEnvelope: {
                  payloadType: 'application/vnd.in-toto+json',
                  payload: 'not-base64',
                  signatures: [{}],
                },
              },
            },
          ],
        },
      },
      /DSSE payload is malformed/,
    ],
    [
      'wrong subject',
      { provenance: attestation({ subjectName: 'pkg:npm/other@0.22.0' }) },
      /subject does not match/,
    ],
    [
      'wrong integrity',
      {
        registry: metadata({
          integrity:
            'sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==',
        }),
      },
      /installed package lock does not match/,
    ],
    [
      'wrong source repository',
      { provenance: attestation({ repository: 'github.com/other/project' }) },
      /source dependency is missing/,
    ],
    [
      'wrong source commit',
      { provenance: attestation({ commit: 'b'.repeat(40) }) },
      /source dependency is missing/,
    ],
    [
      'ambiguous source statements',
      { provenance: attestation({ duplicateSource: true }) },
      /source dependency is missing or ambiguous/,
    ],
    [
      'mixed attestation statements',
      {
        provenance: {
          attestations: [attestation().attestations[0], attestation().attestations[0]],
        },
      },
      /missing or ambiguous/,
    ],
  ])('%s', async (_label, options, error) => {
    await expect(verify(options)).rejects.toThrow(error);
  });

  it('rejects an attestation URL outside the bounded npm registry', async () => {
    await expect(
      verify({ registry: metadata({ url: 'https://attacker.example.test/a@0.22.0' }) }),
    ).rejects.toThrow(/outside the registry boundary/);
  });

  it('rejects an attestation URL for a different release', async () => {
    await expect(
      verify({
        registry: metadata({
          url: 'https://registry.npmjs.org/-/npm/v1/attestations/@discord-mcp/cli@0.21.0',
        }),
      }),
    ).rejects.toThrow(/does not identify/);
  });

  it('binds the installed package lock to the official registry artifact', async () => {
    await expect(
      verify({
        readLockfile: async () => ({
          lockfileVersion: 3,
          packages: {
            [`node_modules/${PACKAGE}`]: {
              version: RELEASE,
              integrity:
                'sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==',
            },
          },
        }),
      }),
    ).rejects.toThrow(/does not match official registry integrity/);
  });
});

describe('npm provenance parser boundaries', () => {
  it('resolves npm only from the active Node installation', async () => {
    const npmCli = 'C:\\trusted-node\\node_modules\\npm\\bin\\npm-cli.js';
    const result = await resolveTrustedNpmCli({
      execPath: 'C:\\trusted-node\\node.exe',
      platform: 'win32',
      realpath: async (path) => path,
      lstat: async (path) => ({
        isFile: () => path === npmCli,
        isSymbolicLink: () => false,
        size: 64,
      }),
    });
    expect(result).toBe(npmCli);
  });

  it('resolves the standard POSIX Node-adjacent npm installation', async () => {
    const npmCli = '/opt/node/lib/node_modules/npm/bin/npm-cli.js';
    const result = await resolveTrustedNpmCli({
      execPath: '/opt/node/bin/node',
      platform: 'linux',
      realpath: async (path) => path,
      lstat: async (path) => ({
        isFile: () => path === npmCli,
        isSymbolicLink: () => false,
        size: 64,
      }),
    });
    expect(result).toBe(npmCli);
  });

  it('fails closed when the Node-adjacent npm CLI is a symlink', async () => {
    await expect(
      resolveTrustedNpmCli({
        execPath: 'C:\\trusted-node\\node.exe',
        platform: 'win32',
        realpath: async (path) => path,
        lstat: async () => ({
          isFile: () => true,
          isSymbolicLink: () => true,
          size: 64,
        }),
      }),
    ).rejects.toThrow(/trusted npm CLI is unavailable/);
  });

  it('requires canonical, bounded registry URLs', () => {
    expect(() =>
      __private.boundedRegistryUrl('http://registry.npmjs.org/x@0.22.0', PACKAGE, RELEASE),
    ).toThrow();
    expect(() =>
      __private.boundedRegistryUrl(`${ATTESTATION_URL}?token=secret`, PACKAGE, RELEASE),
    ).toThrow();
    expect(__private.npmPurl(PACKAGE, RELEASE)).toBe(PACKAGE_PURL);
  });
});
