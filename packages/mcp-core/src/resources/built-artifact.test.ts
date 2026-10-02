/**
 * Exercise the BUILT artifact, not the source tree.
 *
 * Every other test in this package imports from `src/`, where a path computed
 * from `import.meta.url` resolves correctly. The published package ships its
 * entrypoint and lazy chunks with `files: ["dist"]`, so anything read from disk at
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
 * Build the core package before running this suite.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { REST } from '@discordjs/rest';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
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

  it('loads the packaged template catalog lazily on first use', async () => {
    const { readFileSync } = await import('node:fs');
    const bundle = readFileSync(DIST, 'utf8');
    expect(bundle).not.toContain('WNSCpfHWnqXr');
    const { buildServer, createLogger, loadConfig } =
      (await importDist()) as typeof import('../index.js');
    const config = loadConfig({
      DISCORD_TOKEN: `Bot ${'a'.repeat(60)}`,
      LOG_LEVEL: 'fatal',
      MCP_AUDIT_ENABLED: 'false',
      MCP_TOOL_SURFACE: 'progressive',
      MCP_CATEGORIES: 'templates',
    });
    let restRequests = 0;
    const rest = new REST({
      version: '10',
      makeRequest: async () => {
        restRequests += 1;
        throw new Error('built catalog check must not contact Discord');
      },
    }).setToken('fake-token');
    const built = await buildServer({ rest, logger: createLogger(config), config });
    const client = new Client({ name: 'built-catalog-test', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([built.server.connect(serverTransport), client.connect(clientTransport)]);
      await client.listTools();
      const result = await client.callTool({
        name: 'mcp_tools_read',
        arguments: { tool: 'templates_recommend', args: { request: 'zzzxxyyqq' } },
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        status: 'no_match',
        catalog_version: 'd48cec3acf16c56138b7c303d711717aabc11b0e5813865b8926c2d6952212fe',
        verification: { catalog_records: 4_970, rest_requests: 0 },
      });
      expect(restRequests).toBe(0);
    } finally {
      await client.close();
      await built.server.close();
    }
  });

  it('reports the real version from the built package', async () => {
    const mod = await importDist();
    expect(mod.VERSION).not.toBe('0.0.0');
    expect(String(mod.VERSION)).toMatch(/^\d+\.\d+\.\d+/);
  });
});
