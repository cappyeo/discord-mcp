import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';
import {
  buildActivationMatrixCampaigns,
  main,
  parseActivationMatrixArgs,
} from './verify-activation-matrix.mjs';
import { PRODUCTION_ACTIVATION_HOSTS } from './verify-activation-trials.mjs';

const COMMIT = 'a'.repeat(40);
const BUILD = `sha256:${createHash('sha256').update('package').digest('hex')}`;
const ROOT = join(tmpdir(), 'discord-mcp-activation-matrix');
const GUILD_ID = '1537332825978568744';
const BOT_ID = '1533998797863256165';
const TOKEN = 'matrix-integrity-key';

function runIds() {
  return Object.fromEntries(
    PRODUCTION_ACTIVATION_HOSTS.map((host) => [host, `${host}-activation-run-001`]),
  );
}

function args(overrides = {}) {
  const ids = { ...runIds(), ...overrides };
  return [
    '--artifact-root',
    ROOT,
    '--expected-release',
    '0.24.0',
    '--expected-commit',
    COMMIT,
    '--expected-build-digest',
    BUILD,
    ...PRODUCTION_ACTIVATION_HOSTS.flatMap((host) => [`--${host}-run-id`, ids[host]]),
  ];
}

describe('production activation matrix CLI', () => {
  it('parses the exact five-host contract and derives private artifact locations', () => {
    const parsed = parseActivationMatrixArgs(args());
    expect(parsed.runIds).toEqual(runIds());
    const campaigns = buildActivationMatrixCampaigns(parsed.artifactRoot, parsed.runIds);
    expect(Object.keys(campaigns)).toEqual(PRODUCTION_ACTIVATION_HOSTS);
    expect(campaigns['grok-cli']).toEqual({
      inputPath: join(
        ROOT,
        'runs',
        'grok-cli-activation-run-001',
        'results',
        'activation-trials-bundle.json',
      ),
      evidenceDir: join(ROOT, 'activation-evidence', 'grok-cli-activation-run-001'),
      expectedRunId: 'grok-cli-activation-run-001',
    });
  });

  it('rejects a partial matrix and campaign run-id reuse', () => {
    expect(() => parseActivationMatrixArgs(args().slice(0, -2))).toThrow(/arguments/);
    expect(() =>
      parseActivationMatrixArgs(
        args({
          'grok-cli': 'cursor-cli-activation-run-001',
        }),
      ),
    ).toThrow(/arguments/);
  });

  it('prints only the secret-free aggregate after the authoritative verifier passes', async () => {
    const output = [];
    const verify = vi.fn(async () => ({
      schema_version: 'discord-mcp.activation-trials-verifier.v2',
      artifact_schema: 'discord-mcp.activation-trial.v3',
      verified: true,
      release: '0.24.0',
      source_commit: COMMIT,
      build_digest: BUILD,
      host_count: 5,
      hosts: [],
    }));
    await expect(
      main({
        argv: args(),
        environment: {
          DISCORD_TESTBOT_B_TOKEN: TOKEN,
          DISCORD_ACTIVATION_GUILD_ID: GUILD_ID,
          DISCORD_EXPECTED_BOT_ID: BOT_ID,
        },
        stdout: { write: (value) => output.push(value) },
        verify,
        validateActivityEvidence: () => true,
      }),
    ).resolves.toBe(0);
    expect(verify).toHaveBeenCalledOnce();
    expect(verify.mock.calls[0][0]).toMatchObject({
      integrityKey: TOKEN,
      expectedBinding: { guildId: GUILD_ID, botId: BOT_ID },
      expectedRelease: '0.24.0',
      expectedCommit: COMMIT,
      expectedBuildDigest: BUILD,
    });
    expect(output.join('')).not.toContain(TOKEN);
    expect(JSON.parse(output.join(''))).toMatchObject({ verified: true, host_count: 5 });
  });

  it('fails closed with one generic envelope and no exception or credential text', async () => {
    const output = [];
    const code = await main({
      argv: args(),
      environment: {
        DISCORD_TESTBOT_B_TOKEN: TOKEN,
        DISCORD_ACTIVATION_GUILD_ID: GUILD_ID,
        DISCORD_EXPECTED_BOT_ID: BOT_ID,
      },
      stdout: { write: (value) => output.push(value) },
      verify: async () => {
        throw new Error(`private failure ${TOKEN}`);
      },
      validateActivityEvidence: () => true,
    });
    expect(code).toBe(1);
    expect(output).toEqual([
      `${JSON.stringify({
        schema_version: 'discord-mcp.activation-trials-verifier.v2',
        verified: false,
        error: 'activation matrix verification failed',
      })}\n`,
    ]);
    expect(output.join('')).not.toContain(TOKEN);
  });
});
