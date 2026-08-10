#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

const SCHEMA_VERSION = 1;
const HASH_PATTERN = /^[a-f0-9]{64}$/i;
const SNOWFLAKE_PATTERN = /^\d{17,20}$/;
const CODE_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;
const MAX_SOURCE_URL_LENGTH = 2048;
const MAX_NAME_LENGTH = 256;
const MAX_DESCRIPTION_LENGTH = 4096;
const MAX_TAG_LENGTH = 64;
const MAX_TAGS = 16;

const SQLITE_SCHEMA = `
  PRAGMA foreign_keys = ON;
  CREATE TABLE snapshot (
    schema_version INTEGER NOT NULL CHECK (schema_version = 1),
    sitemap_sha256 TEXT NOT NULL CHECK (length(sitemap_sha256) = 64),
    ids_sha256 TEXT NOT NULL CHECK (length(ids_sha256) = 64),
    source_catalog TEXT NOT NULL CHECK (length(source_catalog) BETWEEN 1 AND 2048),
    source_sitemap TEXT NOT NULL CHECK (length(source_sitemap) BETWEEN 1 AND 2048),
    code_resolution TEXT NOT NULL CHECK (length(code_resolution) BETWEEN 1 AND 256),
    code_snapshot_at TEXT NOT NULL CHECK (length(code_snapshot_at) BETWEEN 1 AND 128),
    metadata_captured_at TEXT NOT NULL CHECK (length(metadata_captured_at) BETWEEN 1 AND 128),
    record_count INTEGER NOT NULL CHECK (record_count >= 0),
    active_count INTEGER NOT NULL CHECK (active_count >= 0),
    deleted_count INTEGER NOT NULL CHECK (deleted_count >= 0),
    unresolved_count INTEGER NOT NULL CHECK (unresolved_count >= 0)
  ) STRICT;

  CREATE TABLE templates (
    source_guild_id TEXT PRIMARY KEY CHECK (length(source_guild_id) BETWEEN 17 AND 20 AND source_guild_id NOT GLOB '*[^0-9]*'),
    code TEXT UNIQUE CHECK (code IS NULL OR (length(code) BETWEEN 1 AND 100 AND code NOT GLOB '*[^A-Za-z0-9_-]*')),
    availability TEXT NOT NULL CHECK (availability IN ('active', 'deleted')),
    canonical_url TEXT CHECK (canonical_url IS NULL OR length(canonical_url) BETWEEN 1 AND 2048),
    name_display TEXT NOT NULL CHECK (length(name_display) BETWEEN 1 AND 256),
    description_display TEXT NOT NULL CHECK (length(description_display) BETWEEN 0 AND 4096),
    description_missing INTEGER NOT NULL CHECK (description_missing IN (0, 1)),
    usage_count INTEGER NOT NULL CHECK (usage_count >= 0),
    source_url TEXT NOT NULL CHECK (length(source_url) BETWEEN 1 AND 2048),
    page INTEGER NOT NULL CHECK (page >= 1),
    page_ordinal INTEGER NOT NULL CHECK (page_ordinal >= 1),
    ordinal INTEGER NOT NULL CHECK (ordinal >= 1),
    CHECK (availability = 'active' AND code IS NOT NULL AND canonical_url = 'https://discord.new/' || code
      OR availability = 'deleted' AND code IS NULL AND canonical_url IS NULL)
  ) STRICT;

  CREATE TABLE tags (
    source_guild_id TEXT NOT NULL REFERENCES templates(source_guild_id) ON DELETE CASCADE,
    tag TEXT NOT NULL CHECK (length(tag) BETWEEN 1 AND 64),
    PRIMARY KEY (source_guild_id, tag)
  ) STRICT;
`;

function fail(message) {
  throw new Error(`Catalog validation failed: ${message}`);
}

function assertObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    fail(`${label} must be an object`);
}

function assertBoundedString(value, label, min, max) {
  const hasControlCharacter =
    typeof value === 'string' &&
    [...value].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f;
    });
  if (
    typeof value !== 'string' ||
    value.length < min ||
    value.length > max ||
    hasControlCharacter
  ) {
    fail(`${label} must be a string of length ${min}..${max} without control characters`);
  }
}

function assertNonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) fail(`${label} must be a non-negative integer`);
}

function validateInput(input) {
  assertObject(input, 'catalog');
  if (input.schema_version !== SCHEMA_VERSION) fail(`schema_version must be ${SCHEMA_VERSION}`);
  assertObject(input.source, 'source');
  for (const key of ['catalog', 'sitemap', 'code_resolution']) {
    assertBoundedString(
      input.source[key],
      `source.${key}`,
      1,
      key === 'code_resolution' ? 256 : MAX_SOURCE_URL_LENGTH,
    );
  }
  for (const key of ['sitemap_sha256', 'ids_sha256']) {
    if (typeof input[key] !== 'string' || !HASH_PATTERN.test(input[key]))
      fail(`${key} must be a 64-character SHA-256 hex digest`);
  }
  for (const key of ['code_snapshot_at', 'metadata_captured_at'])
    assertBoundedString(input[key], key, 1, 128);
  for (const key of ['record_count', 'active_count', 'deleted_count', 'unresolved_count'])
    assertNonNegativeInteger(input[key], key);
  if (!Array.isArray(input.records)) fail('records must be an array');
  if (input.record_count !== input.records.length)
    fail(
      `record_count ${input.record_count} does not match records.length ${input.records.length}`,
    );
  if (input.unresolved_count !== 0) fail('unresolved_count must be 0 for schema v1');
  if (input.record_count !== input.active_count + input.deleted_count)
    fail('record_count must equal active_count + deleted_count');

  const ids = new Set();
  const codes = new Set();
  let active = 0;
  let deleted = 0;
  for (const [index, record] of input.records.entries()) {
    const label = `records[${index}]`;
    assertObject(record, label);
    if (
      typeof record.source_guild_id !== 'string' ||
      !SNOWFLAKE_PATTERN.test(record.source_guild_id)
    )
      fail(`${label}.source_guild_id is not a Discord snowflake`);
    if (ids.has(record.source_guild_id))
      fail(`duplicate source_guild_id ${record.source_guild_id}`);
    ids.add(record.source_guild_id);
    if (record.availability !== 'active' && record.availability !== 'deleted')
      fail(`${label}.availability must be active or deleted`);
    if (record.availability === 'active') {
      active += 1;
      if (typeof record.code !== 'string' || !CODE_PATTERN.test(record.code))
        fail(`${label}.code is invalid for an active template`);
      if (codes.has(record.code)) fail(`duplicate active code ${record.code}`);
      codes.add(record.code);
      if (record.canonical_url !== `https://discord.new/${record.code}`)
        fail(`${label}.canonical_url must match code`);
    } else {
      deleted += 1;
      if (record.code !== null || record.canonical_url !== null)
        fail(`${label} deleted template must have null code and canonical_url`);
    }
    assertBoundedString(record.name_display, `${label}.name_display`, 1, MAX_NAME_LENGTH);
    assertBoundedString(
      record.description_display,
      `${label}.description_display`,
      0,
      MAX_DESCRIPTION_LENGTH,
    );
    if (typeof record.description_missing !== 'boolean')
      fail(`${label}.description_missing must be boolean`);
    assertNonNegativeInteger(record.usage_count, `${label}.usage_count`);
    if (!Array.isArray(record.tags) || record.tags.length > MAX_TAGS)
      fail(`${label}.tags must be an array of at most ${MAX_TAGS} items`);
    const recordTags = new Set();
    for (const tag of record.tags) {
      assertBoundedString(tag, `${label}.tag`, 1, MAX_TAG_LENGTH);
      const normalizedTag = tag.trim().toLowerCase();
      if (!normalizedTag || recordTags.has(normalizedTag))
        fail(`${label}.tags must contain unique non-empty values`);
      recordTags.add(normalizedTag);
    }
    assertBoundedString(record.source_url, `${label}.source_url`, 1, MAX_SOURCE_URL_LENGTH);
    assertNonNegativeInteger(record.page, `${label}.page`);
    assertNonNegativeInteger(record.page_ordinal, `${label}.page_ordinal`);
    assertNonNegativeInteger(record.ordinal, `${label}.ordinal`);
    if (record.page < 1 || record.page_ordinal < 1 || record.ordinal < 1)
      fail(`${label} page and ordinal values must be positive`);
  }
  if (active !== input.active_count || deleted !== input.deleted_count)
    fail(`active/deleted counts do not match records`);
}

function buildDatabase(input) {
  validateInput(input);
  const db = new DatabaseSync(':memory:');
  db.exec(SQLITE_SCHEMA);
  db.prepare(`INSERT INTO snapshot VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    input.schema_version,
    input.sitemap_sha256.toLowerCase(),
    input.ids_sha256.toLowerCase(),
    input.source.catalog,
    input.source.sitemap,
    input.source.code_resolution,
    input.code_snapshot_at,
    input.metadata_captured_at,
    input.record_count,
    input.active_count,
    input.deleted_count,
    input.unresolved_count,
  );
  const templateInsert = db.prepare(
    `INSERT INTO templates (source_guild_id, code, availability, canonical_url, name_display, description_display, description_missing, usage_count, source_url, page, page_ordinal, ordinal) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const tagInsert = db.prepare('INSERT INTO tags (source_guild_id, tag) VALUES (?, ?)');
  for (const record of input.records) {
    templateInsert.run(
      record.source_guild_id,
      record.code,
      record.availability,
      record.canonical_url,
      record.name_display,
      record.description_display,
      record.description_missing ? 1 : 0,
      record.usage_count,
      record.source_url,
      record.page,
      record.page_ordinal,
      record.ordinal,
    );
    for (const tag of record.tags) tagInsert.run(record.source_guild_id, tag.trim().toLowerCase());
  }
  return db;
}

function exportCatalog(db) {
  const snapshot = db.prepare('SELECT * FROM snapshot').get();
  const records = db
    .prepare(
      `SELECT source_guild_id, code, availability, name_display, description_display, description_missing, usage_count FROM templates ORDER BY CASE WHEN code IS NULL THEN 1 ELSE 0 END ASC, code ASC, source_guild_id ASC`,
    )
    .all();
  const tags = db
    .prepare('SELECT source_guild_id, tag FROM tags ORDER BY source_guild_id ASC, tag ASC')
    .all();
  const tagsById = new Map();
  for (const row of tags) {
    const values = tagsById.get(row.source_guild_id) ?? [];
    values.push(row.tag);
    tagsById.set(row.source_guild_id, values);
  }
  return {
    schema_version: SCHEMA_VERSION,
    version: snapshot.sitemap_sha256,
    snapshot: {
      sitemap_sha256: snapshot.sitemap_sha256,
      ids_sha256: snapshot.ids_sha256,
      source: {
        catalog: snapshot.source_catalog,
        sitemap: snapshot.source_sitemap,
        code_resolution: snapshot.code_resolution,
      },
      code_snapshot_at: snapshot.code_snapshot_at,
      metadata_captured_at: snapshot.metadata_captured_at,
    },
    counts: {
      total: snapshot.record_count,
      active: snapshot.active_count,
      deleted: snapshot.deleted_count,
      unresolved: snapshot.unresolved_count,
    },
    records: records.map((record) => ({
      source_guild_id: record.source_guild_id,
      code: record.code,
      availability: record.availability,
      name: record.name_display,
      description: record.description_missing ? null : record.description_display,
      usage_count: record.usage_count,
      tags: tagsById.get(record.source_guild_id) ?? [],
    })),
  };
}

export function compileCatalog(input) {
  const db = buildDatabase(input);
  try {
    return exportCatalog(db);
  } finally {
    db.close();
  }
}

function usage() {
  return [
    'Usage: node --experimental-sqlite scripts/catalog/build.mjs --input <merged-catalog.json> --output <compiled-catalog.json>',
    '',
    'Compile and validate a merged Discord Templates catalog into a deterministic runtime index.',
    'Options:',
    '  --input <path>   Merged catalog JSON input',
    '  --output <path>  Compiled catalog JSON output',
    '  --help           Show this help',
  ].join('\n');
}

function parseArgs(args) {
  if (args.includes('--help') || args.includes('-h')) return { help: true };
  const values = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg !== '--input' && arg !== '--output') fail(`unknown option ${arg}`);
    const value = args[index + 1];
    if (!value || value.startsWith('--')) fail(`${arg} requires a path`);
    values[arg.slice(2)] = value;
    index += 1;
  }
  if (!values.input || !values.output) fail('--input and --output are required');
  return values;
}

export async function main(args = process.argv.slice(2)) {
  const options = parseArgs(args);
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  const input = JSON.parse(await readFile(options.input, 'utf8'));
  const output = compileCatalog(input);
  await writeFile(options.output, `${JSON.stringify(output)}\n`, 'utf8');
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
