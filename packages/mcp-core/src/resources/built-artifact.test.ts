/**
 * Exercise the BUILT artifact, not the source tree.
 *
 * Every other test in this package imports from `src/`, where a path computed
 * from `import.meta.url` resolves correctly. The published package is a single
 * bundled `dist/index.js` with `files: ["dist"]`, so anything read from disk at
 * runtime relative to the module has a different - usually nonexistent - path
 * there.
 *
 * That gap shipped a real defect: the five Components V2 templates were loaded
 * with `readdir`/`readFile` against `join(__dirname, '..', 'tools',
 * 'components-v2', 'templates')`. In `dist/` that resolves to
 * `packages/mcp-core/tools/...`, which does not exist, and the `.json` files
 * were not in the tarball at all. `resources/list` threw and
 * `components_v2_send_from_template` failed for every template - for every
 * consumer - while all 1000+ tests passed.
 *
 * `vitest.global-setup.ts` guarantees `dist/` exists before this runs.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const DIST = fileURLToPath(new URL('../../dist/index.js', import.meta.url));

async function importDist(): Promise<Record<string, unknown>> {
  return (await import(
    /* @vite-ignore */ new URL(`file://${DIST.replace(/\\/g, '/')}`).href
  )) as unknown as Record<string, unknown>;
}

describe('built artifact', () => {
  it('exists (guards the guard)', () => {
    expect(existsSync(DIST), `expected a build at ${DIST}`).toBe(true);
  });

  it('lists the V2 resources without touching the filesystem', async () => {
    const mod = await importDist();
    const listV2Resources = mod.listV2Resources as
      | (() => Promise<readonly { uri: string }[]>)
      | undefined;
    // Only assert if the symbol is exported; the resource list is also
    // reachable through buildServer, which needs a full container.
    if (typeof listV2Resources !== 'function') return;
    const entries = await listV2Resources();
    const uris = entries.map((e) => e.uri);
    expect(uris).toContain('discord://components-v2/schema');
    for (const name of [
      'announcement',
      'incident_status',
      'poll_results',
      'release_notes',
      'welcome_card',
    ]) {
      expect(uris, `template ${name} missing from the built package`).toContain(
        `discord://components-v2/templates/${name}`,
      );
    }
  });

  it('inlines every template into the bundle', async () => {
    // Independent of the export surface: the bundle must physically contain
    // the template payloads, because nothing ships them alongside it.
    const { readFileSync } = await import('node:fs');
    const bundle = readFileSync(DIST, 'utf8');
    for (const name of [
      'announcement',
      'incident_status',
      'poll_results',
      'release_notes',
      'welcome_card',
    ]) {
      expect(bundle.includes(name), `template ${name} not bundled into dist/index.js`).toBe(true);
    }
  });

  it('inlines the bundled template catalog into the package artifact', async () => {
    // The catalog is imported by templates_recommend and the published package
    // ships only dist/. Keep these checks on the built file so a source-only
    // catalog test cannot pass when the JSON is accidentally left outside the
    // package artifact or omitted by the bundler.
    const { readFileSync } = await import('node:fs');
    const bundle = readFileSync(DIST, 'utf8');
    expect(bundle).toContain('d48cec3acf16c56138b7c303d711717aabc11b0e5813865b8926c2d6952212fe');
    expect(bundle).toContain('WNSCpfHWnqXr');
  });

  it('reports the real version from the built package', async () => {
    const mod = await importDist();
    expect(mod.VERSION).not.toBe('0.0.0');
    expect(String(mod.VERSION)).toMatch(/^\d+\.\d+\.\d+/);
  });
});
