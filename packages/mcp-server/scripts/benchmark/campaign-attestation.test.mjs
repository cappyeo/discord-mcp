import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  CAMPAIGN_ARTIFACT_PATHS,
  verifyCampaignAttestation,
  writeCampaignAttestation,
} from './campaign-attestation.mjs';

const RUN_ID = 'real-20-test-official';
const COMMIT = '0123456789abcdef0123456789abcdef01234567';
const KEY = 'discord-benchmark-test-token';

async function fixture() {
  const runDirectory = await mkdtemp(join(tmpdir(), 'discord-mcp-campaign-attestation-'));
  await mkdir(join(runDirectory, 'results'));
  for (const relativePath of CAMPAIGN_ARTIFACT_PATHS) {
    const path = join(runDirectory, relativePath);
    await writeFile(path, JSON.stringify({ path: relativePath, value: 'fixture' }));
  }
  return runDirectory;
}

describe('campaign artifact attestation', () => {
  it('binds the exact 24 evidence files to a context-separated HMAC', async () => {
    const runDirectory = await fixture();
    try {
      const attestation = await writeCampaignAttestation({
        runDirectory,
        runId: RUN_ID,
        commit: COMMIT,
        integrityKey: KEY,
      });
      expect(Object.keys(attestation.artifacts)).toHaveLength(24);
      expect(attestation.integrity.context).toBe('discord-mcp.real-benchmark-attestation:v1');
      expect(attestation.integrity.digest).toMatch(/^[a-f0-9]{64}$/);
      await expect(
        verifyCampaignAttestation({
          runDirectory,
          runId: RUN_ID,
          commit: COMMIT,
          integrityKey: KEY,
        }),
      ).resolves.toEqual(attestation);
    } finally {
      await rm(runDirectory, { recursive: true, force: true });
    }
  });

  it('rejects wrong keys, identity changes, and evidence tampering', async () => {
    const runDirectory = await fixture();
    try {
      await writeCampaignAttestation({
        runDirectory,
        runId: RUN_ID,
        commit: COMMIT,
        integrityKey: KEY,
      });
      await expect(
        verifyCampaignAttestation({
          runDirectory,
          runId: RUN_ID,
          commit: COMMIT,
          integrityKey: 'wrong-key',
        }),
      ).rejects.toThrow(/HMAC/);
      await expect(
        verifyCampaignAttestation({
          runDirectory,
          runId: 'other-run',
          commit: COMMIT,
          integrityKey: KEY,
        }),
      ).rejects.toThrow(/identity/);
      await writeFile(join(runDirectory, 'report.json'), '{"tampered":true}');
      await expect(
        verifyCampaignAttestation({
          runDirectory,
          runId: RUN_ID,
          commit: COMMIT,
          integrityKey: KEY,
        }),
      ).rejects.toThrow(/digest/);
    } finally {
      await rm(runDirectory, { recursive: true, force: true });
    }
  });

  it('uses the real file bytes, not canonicalized parsed JSON', async () => {
    const runDirectory = await fixture();
    try {
      await writeCampaignAttestation({
        runDirectory,
        runId: RUN_ID,
        commit: COMMIT,
        integrityKey: KEY,
      });
      const reportPath = join(runDirectory, 'report.json');
      const original = await readFile(reportPath, 'utf8');
      await writeFile(reportPath, `${JSON.stringify(JSON.parse(original), null, 4)}\n`);
      await expect(
        verifyCampaignAttestation({
          runDirectory,
          runId: RUN_ID,
          commit: COMMIT,
          integrityKey: KEY,
        }),
      ).rejects.toThrow(/digest/);
      expect(createHash('sha256').update(original).digest('hex')).not.toBe(
        createHash('sha256')
          .update(await readFile(reportPath))
          .digest('hex'),
      );
    } finally {
      await rm(runDirectory, { recursive: true, force: true });
    }
  });

  it('writes the attestation exclusively and refuses a second publisher', async () => {
    const runDirectory = await fixture();
    try {
      await writeCampaignAttestation({
        runDirectory,
        runId: RUN_ID,
        commit: COMMIT,
        integrityKey: KEY,
      });
      await expect(
        writeCampaignAttestation({
          runDirectory,
          runId: RUN_ID,
          commit: COMMIT,
          integrityKey: KEY,
        }),
      ).rejects.toThrow();
    } finally {
      await rm(runDirectory, { recursive: true, force: true });
    }
  });

  it('rejects oversized attestation metadata before parsing it', async () => {
    const runDirectory = await fixture();
    try {
      await writeFile(join(runDirectory, 'attestation.json'), Buffer.alloc(1024 * 1024 + 1, 0x20));
      await expect(
        verifyCampaignAttestation({
          runDirectory,
          runId: RUN_ID,
          commit: COMMIT,
          integrityKey: KEY,
        }),
      ).rejects.toThrow(/outside the size bound/);
    } finally {
      await rm(runDirectory, { recursive: true, force: true });
    }
  });
});
