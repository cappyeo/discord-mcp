import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createSmallModelIntegrity } from './small-model-attestation.mjs';
import { runSmallModelEvaluation } from './small-model-eval.mjs';
import { parseSmallModelVerifierArgs, verifySmallModelArtifact } from './verify-small-model.mjs';

const TOKEN = 'caller-owned-discord-token-'.padEnd(60, 'x');
const COMMIT = 'a'.repeat(40);
const TARGET = {
  DISCORD_TOKEN: TOKEN,
  ALLOWED_GUILDS: '1533998797863256165',
  DISCORD_DEFAULT_GUILD_ID: '1533998797863256165',
  DISCORD_EXPECTED_BOT_ID: '1533457669384306858',
};

function sha256(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

async function makeArtifact() {
  const directory = await mkdtemp(join(tmpdir(), 'discord-mcp-small-model-verify-'));
  const cliRelative = 'packages/mcp-server/dist/cli.js';
  const coreRelative = 'packages/mcp-core/dist/index.js';
  const cliPath = join(directory, cliRelative);
  const corePath = join(directory, coreRelative);
  await mkdir(join(directory, 'packages/mcp-server/dist'), { recursive: true });
  await mkdir(join(directory, 'packages/mcp-core/dist'), { recursive: true });
  const cliBytes = Buffer.from('fixture-cli');
  const coreBytes = Buffer.from('fixture-core');
  await writeFile(cliPath, cliBytes);
  await writeFile(corePath, coreBytes);
  const output = join(directory, 'result.json');
  const artifact = await runSmallModelEvaluation({
    output,
    cwd: 'C:/repo',
    trials: 5,
    threshold: 4,
    env: TARGET,
    run: async () => ({ stdout: `${COMMIT}\n` }),
    attest: async () => ({
      cliPath,
      attestation: {
        entrypoint: cliRelative,
        sha256: sha256(cliBytes),
        source_commit: COMMIT,
        core_entrypoint: coreRelative,
        core_sha256: sha256(coreBytes),
        core_source_commit: COMMIT,
        files: [{ path: cliRelative, sha256: sha256(cliBytes) }],
        core_files: [{ path: coreRelative, sha256: sha256(coreBytes) }],
      },
    }),
    openSession: async () => ({
      toolNames: [],
      instructions: '',
      close: async () => {},
    }),
  });
  return { directory, output, artifact };
}

describe('independent small-model verifier', () => {
  it('parses only the exact verifier CLI contract', () => {
    const valid = ['--artifact', 'C:/evidence.json', '--expected-commit', COMMIT];
    expect(parseSmallModelVerifierArgs(valid)).toEqual({
      artifactPath: 'C:/evidence.json',
      expectedCommit: COMMIT,
    });
    expect(() => parseSmallModelVerifierArgs([...valid, '--unknown', 'value'])).toThrow(/usage/);
    expect(() => parseSmallModelVerifierArgs([...valid, '--artifact', 'C:/other.json'])).toThrow(
      /usage/,
    );
    expect(() => parseSmallModelVerifierArgs(['--artifact', '--expected-commit', COMMIT])).toThrow(
      /usage/,
    );
  });

  it('authenticates policy-conditioned preview evidence and binds build artifacts', async () => {
    const test = await makeArtifact();
    try {
      await expect(
        verifySmallModelArtifact({
          artifactPath: test.output,
          expectedCommit: COMMIT,
          integrityKey: TOKEN,
          repoRoot: test.directory,
        }),
      ).resolves.toMatchObject({
        hmac_verified: true,
        build_attestation_verified: true,
        policy_conditioned: true,
        mutation_execution: false,
        meets_threshold: false,
      });
      expect(JSON.stringify(JSON.parse(await readFile(test.output, 'utf8')))).not.toContain(TOKEN);
    } finally {
      await rm(test.directory, { recursive: true, force: true });
    }
  });

  it('rejects artifact tampering and re-signing with the wrong caller secret', async () => {
    const test = await makeArtifact();
    try {
      const tampered = JSON.parse(await readFile(test.output, 'utf8'));
      tampered.aggregate.passes = 2;
      await writeFile(test.output, `${JSON.stringify(tampered)}\n`);
      await expect(
        verifySmallModelArtifact({
          artifactPath: test.output,
          expectedCommit: COMMIT,
          integrityKey: TOKEN,
          repoRoot: test.directory,
        }),
      ).rejects.toThrow(/HMAC/);

      const resigned = JSON.parse(await readFile(test.output, 'utf8'));
      resigned.aggregate.meets_threshold = true;
      resigned.integrity = createSmallModelIntegrity({
        artifact: resigned,
        integrityKey: 'wrong-caller-token'.padEnd(60, 'y'),
      });
      await writeFile(test.output, `${JSON.stringify(resigned)}\n`);
      await expect(
        verifySmallModelArtifact({
          artifactPath: test.output,
          expectedCommit: COMMIT,
          integrityKey: TOKEN,
          repoRoot: test.directory,
        }),
      ).rejects.toThrow(/HMAC/);
    } finally {
      await rm(test.directory, { recursive: true, force: true });
    }
  });

  it('rejects a caller-signed downgrade of the fixed five-trial, four-pass gate', async () => {
    const test = await makeArtifact();
    try {
      const artifact = JSON.parse(await readFile(test.output, 'utf8'));
      artifact.aggregate.required_passes = 1;
      artifact.aggregate.meets_threshold = true;
      artifact.integrity = createSmallModelIntegrity({ artifact, integrityKey: TOKEN });
      await writeFile(test.output, `${JSON.stringify(artifact)}\n`);
      await expect(
        verifySmallModelArtifact({
          artifactPath: test.output,
          expectedCommit: COMMIT,
          integrityKey: TOKEN,
          repoRoot: test.directory,
        }),
      ).rejects.toThrow(/aggregate is inconsistent/);

      artifact.trials.pop();
      artifact.aggregate.total = artifact.trials.length;
      artifact.aggregate.passes = artifact.trials.filter(
        (trial) => trial.classification === 'pass',
      ).length;
      artifact.aggregate.required_passes = Math.min(4, artifact.aggregate.total);
      artifact.aggregate.meets_threshold =
        artifact.aggregate.passes >= artifact.aggregate.required_passes;
      artifact.integrity = createSmallModelIntegrity({ artifact, integrityKey: TOKEN });
      await writeFile(test.output, `${JSON.stringify(artifact)}\n`);
      await expect(
        verifySmallModelArtifact({
          artifactPath: test.output,
          expectedCommit: COMMIT,
          integrityKey: TOKEN,
          repoRoot: test.directory,
        }),
      ).rejects.toThrow(/exactly 5 trials/);
    } finally {
      await rm(test.directory, { recursive: true, force: true });
    }
  });

  it('rejects secret-bearing fields before attempting authentication', async () => {
    const test = await makeArtifact();
    try {
      const artifact = JSON.parse(await readFile(test.output, 'utf8'));
      artifact.host.codex = `authorization: ${TOKEN}`;
      await writeFile(test.output, `${JSON.stringify(artifact)}\n`);
      await expect(
        verifySmallModelArtifact({
          artifactPath: test.output,
          expectedCommit: COMMIT,
          integrityKey: TOKEN,
          repoRoot: test.directory,
        }),
      ).rejects.toThrow(/Secret-bearing/);
    } finally {
      await rm(test.directory, { recursive: true, force: true });
    }
  });

  it('rejects an artifact whose parent path contains a symlink', async () => {
    const test = await makeArtifact();
    const targetDirectory = join(test.directory, 'artifact-target');
    const linkedDirectory = join(test.directory, 'artifact-link');
    try {
      await mkdir(targetDirectory);
      await writeFile(join(targetDirectory, 'result.json'), await readFile(test.output));
      await symlink(
        targetDirectory,
        linkedDirectory,
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      await expect(
        verifySmallModelArtifact({
          artifactPath: join(linkedDirectory, 'result.json'),
          expectedCommit: COMMIT,
          integrityKey: TOKEN,
          repoRoot: test.directory,
        }),
      ).rejects.toThrow(/small-model artifact contains a symlink/);
    } finally {
      await rm(test.directory, { recursive: true, force: true });
    }
  });
});
