import { deepStrictEqual, match, strictEqual, throws } from 'node:assert';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { compileCatalog } from './build.mjs';

const script = join(import.meta.dirname, 'build.mjs');
const hash = 'a'.repeat(64);

function fixture() {
  return {
    schema_version: 1,
    source: {
      catalog: 'https://discordtemplates.me',
      sitemap: 'https://discordtemplates.me/sitemap.xml',
      code_resolution: 'authenticated website redirect',
    },
    sitemap_sha256: hash,
    ids_sha256: 'b'.repeat(64),
    code_snapshot_at: '2026-08-10T20:14:18Z',
    metadata_captured_at: '2026-08-10T21:19:08Z',
    record_count: 2,
    active_count: 1,
    deleted_count: 1,
    unresolved_count: 0,
    records: [
      {
        source_guild_id: '100000000000000001',
        code: 'zCode_123456',
        availability: 'active',
        canonical_url: 'https://discord.new/zCode_123456',
        name_display: 'Zeta',
        description_display: 'Gaming',
        description_missing: false,
        usage_count: 2,
        tags: ['Gaming', 'community'],
        source_url: 'https://discordtemplates.me/templates/100000000000000001',
        page: 1,
        page_ordinal: 1,
        ordinal: 1,
      },
      {
        source_guild_id: '100000000000000002',
        code: null,
        availability: 'deleted',
        canonical_url: null,
        name_display: 'Old',
        description_display: '',
        description_missing: true,
        usage_count: 0,
        tags: [],
        source_url: 'https://discordtemplates.me/templates/100000000000000002',
        page: 1,
        page_ordinal: 2,
        ordinal: 2,
      },
    ],
  };
}

function runCli(args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--experimental-sqlite', script, ...args], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('build CLI emits deterministic compact catalog', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'discord-mcp-catalog-'));
  try {
    const inputPath = join(directory, 'input.json');
    const outputA = join(directory, 'a.json');
    const outputB = join(directory, 'b.json');
    await writeFile(inputPath, JSON.stringify(fixture()));
    strictEqual((await runCli(['--help'], directory)).code, 0);
    strictEqual((await runCli(['--input', inputPath, '--output', outputA], directory)).code, 0);
    strictEqual((await runCli(['--input', inputPath, '--output', outputB], directory)).code, 0);
    const first = await readFile(outputA, 'utf8');
    const second = await readFile(outputB, 'utf8');
    strictEqual(first, second);
    const result = JSON.parse(first);
    deepStrictEqual(result.counts, { total: 2, active: 1, deleted: 1, unresolved: 0 });
    strictEqual(result.records.length, 2);
    deepStrictEqual(result.records[0].tags, ['community', 'gaming']);
    strictEqual(result.records[1].availability, 'deleted');
    strictEqual(Object.hasOwn(result, 'generated_at'), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('build rejects duplicate active codes and inconsistent URLs', async () => {
  const bad = fixture();
  bad.record_count = 2;
  bad.active_count = 2;
  bad.deleted_count = 0;
  bad.records[1] = { ...bad.records[0], source_guild_id: '100000000000000002' };
  throws(() => compileCatalog(bad), /duplicate active code|canonical_url/);
  const directory = await mkdtemp(join(tmpdir(), 'discord-mcp-catalog-invalid-'));
  try {
    const inputPath = join(directory, 'input.json');
    const outputPath = join(directory, 'output.json');
    const invalid = fixture();
    invalid.records[0].canonical_url = 'https://discord.new/wrong';
    await writeFile(inputPath, JSON.stringify(invalid));
    const result = await runCli(['--input', inputPath, '--output', outputPath], directory);
    strictEqual(result.code, 1);
    match(result.stderr, /Catalog validation failed/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('build rejects unresolved records and inconsistent availability counts', () => {
  const unresolved = fixture();
  unresolved.unresolved_count = 1;
  throws(() => compileCatalog(unresolved), /unresolved_count must be 0/);

  const mismatched = fixture();
  mismatched.deleted_count = 0;
  throws(() => compileCatalog(mismatched), /record_count must equal active_count \+ deleted_count/);
});
