/**
 * The frozen config surface.
 *
 * v1.0.0 commits to "env var names + defaults locked (additions allowed;
 * renames forbidden)". Nothing enforced that, which is how `MCP_TIMEOUT_LONG_MS`
 * shipped documented-and-validated but read by no code path, and how
 * `MCP_CATEGORIES` was advertised as a security control while restricting
 * nothing.
 *
 * The snapshot covers names *and* defaults: a silently changed default is a
 * behavioural break for every existing deployment even though the name is
 * unchanged.
 *
 * The resolved object alone is not the surface. A var declared `.optional()`
 * with no default is absent from `loadConfig()`'s result entirely, so renaming
 * or dropping one moved nothing here - the schema's own key set is snapshotted
 * separately for that reason, plus an explicit list of the vars read outside
 * the schema.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

const MINIMAL_ENV = {
  DISCORD_TOKEN: 'Bot fake.test.token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
} as NodeJS.ProcessEnv;

const SRC_DIR = fileURLToPath(new URL('.', import.meta.url));

/**
 * Top-level keys of `ConfigSchema`, read out of the source because config.ts
 * exports `loadConfig` and the `Config` type but not the schema object.
 */
function schemaKeys(): readonly string[] {
  const source = readFileSync(join(SRC_DIR, 'config.ts'), 'utf8');
  const body = source.slice(
    source.indexOf('const ConfigSchema = z.object({'),
    source.indexOf('export type Config'),
  );
  return [...body.matchAll(/^ {2}([A-Z][A-Z0-9_]*):/gm)].map((m) => m[1] as string).sort();
}

describe('config surface', () => {
  it('resolves to the frozen set of keys and defaults', () => {
    const config = loadConfig(MINIMAL_ENV);
    // DISCORD_TOKEN is the one caller-supplied value; excluded so the snapshot
    // never contains a token-shaped string.
    const {
      DISCORD_TOKEN: _token,
      // Derived from package.json - asserted in version.test.ts. Excluded here
      // so a routine version bump does not churn this snapshot, which exists to
      // catch renames and changed defaults.
      OTEL_SERVICE_VERSION: _version,
      ...rest
    } = config as Record<string, unknown>;
    expect(rest).toMatchSnapshot();
  });

  it('declares the frozen set of schema keys, optional ones included', () => {
    const keys = schemaKeys();
    const resolved = Object.keys(loadConfig(MINIMAL_ENV));
    // Guard the extraction: anything that survives into the resolved config
    // must have been found in the source, or the regex above is silently wrong.
    expect(resolved.filter((k) => !keys.includes(k))).toEqual([]);
    // The reason this snapshot exists: declared, documented, and invisible to
    // the resolved-defaults snapshot above.
    expect(keys).toContain('MCP_CATEGORIES');
    expect(resolved).not.toContain('MCP_CATEGORIES');
    expect(keys).toMatchSnapshot();
  });

  it('names every env var this package reads outside the schema', () => {
    // MCP_DRY_RUN is read straight off the environment in ConfirmRequired, so
    // it never reaches ConfigSchema and neither snapshot above can see it.
    // A second var skipping the schema must be a decision, not an accident.
    const keys = schemaKeys();
    const read = new Set<string>();
    const files = readdirSync(SRC_DIR, { recursive: true, encoding: 'utf8' }).filter(
      (f) => f.endsWith('.ts') && !f.endsWith('.test.ts'),
    );
    for (const file of files) {
      const source = readFileSync(join(SRC_DIR, file), 'utf8');
      // `env.X` and `process.env.X` over this project's env namespaces.
      for (const m of source.matchAll(/\benv\.((?:MCP|OTEL|DISCORD)_[A-Z0-9_]+)/g)) {
        read.add(m[1] as string);
      }
    }
    expect([...read].filter((n) => !keys.includes(n)).sort()).toEqual(['MCP_DRY_RUN']);
  });

  it('reads every documented variable from the environment it is given', () => {
    // loadConfig must not fall through to process.env for anything - the
    // doctor command and the contract tests both depend on being able to
    // evaluate a hypothetical environment.
    const config = loadConfig({ ...MINIMAL_ENV, LOG_LEVEL: 'debug', MCP_BULKHEAD_LIMIT: '7' });
    expect(config.LOG_LEVEL).toBe('debug');
    expect(config.MCP_BULKHEAD_LIMIT).toBe(7);
  });

  it('rejects an invalid value instead of silently defaulting', () => {
    // Fail-fast at boot beats a server that quietly runs with a different
    // policy than the operator configured.
    expect(() => loadConfig({ ...MINIMAL_ENV, LOG_LEVEL: 'chatty' })).toThrow();
    expect(() => loadConfig({ ...MINIMAL_ENV, MCP_RETRY_MAX_ATTEMPTS: '999' })).toThrow();
    expect(() => loadConfig({ ...MINIMAL_ENV, MCP_TOOL_SURFACE: 'compact' })).toThrow();
    expect(() => loadConfig({ ...MINIMAL_ENV, MCP_WRITE_MODE: 'mutate' })).toThrow();
  });
});
