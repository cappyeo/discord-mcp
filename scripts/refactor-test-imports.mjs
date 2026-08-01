#!/usr/bin/env node
// Plan 12 Phase A.4 — one-time migration to rewrite relative imports of
// the root test/setup.js (now packages/mcp-server-mocks/src/setup.ts)
// to the workspace specifier '@discord-mcp/server-mocks'.
//
// Usage: node scripts/refactor-test-imports.mjs
// Safe to delete after Phase A merges.

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const out = execSync('git ls-files packages', { encoding: 'utf8' });
const candidates = out.split('\n').filter((p) => p && /\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(p));

// Match: from '<one-or-more "../">test/setup.js'  (single or double quotes)
const RE = /from\s+(['"])(?:\.\.[\\/])+test[\\/]setup\.js\1/g;

let changed = 0;
for (const file of candidates) {
  const before = readFileSync(file, 'utf8');
  const after = before.replace(RE, "from '@discord-mcp/server-mocks'");
  if (before !== after) {
    writeFileSync(file, after, 'utf8');
    changed++;
    process.stdout.write(`Updated: ${file}\n`);
  }
}
process.stdout.write(`\nTotal files updated: ${changed}\n`);
