import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(__dirname, '../..');
const CONFIG_SOURCE = join(ROOT, 'packages/mcp-core/src/config.ts');
const CONFIG_DOCS = join(ROOT, 'site/src/content/docs/reference/config');
const REFERENCE_INDEX = join(ROOT, 'site/src/content/docs/reference/index.mdx');
const SIDEBAR_CONFIG = join(ROOT, 'site/astro.config.ts');
const MIGRATION_DOCS = join(ROOT, 'site/src/content/docs/migrate');
const CONNECTION_MODES_DOC = join(ROOT, 'site/src/content/docs/operations/clients.mdx');
const OPERATIONS_INDEX = join(ROOT, 'site/src/content/docs/operations/index.mdx');
const CLIENT_SETUP_DOC = join(ROOT, 'site/src/content/docs/start/client-setup.mdx');

function schemaEnvironmentVariables(): string[] {
  const source = readFileSync(CONFIG_SOURCE, 'utf8').replace(/\r\n/g, '\n');
  const body = source.match(/const ConfigSchema = z\.object\(\{([\s\S]*?)^\}\);/m)?.[1];
  expect(body, 'ConfigSchema source').toBeDefined();

  const schemaKeys = [...body!.matchAll(/^ {2}([A-Z][A-Z0-9_]+):/gm)].map((match) => match[1]!);
  return [...schemaKeys, 'MCP_DRY_RUN'].sort();
}

function documentedEnvironmentVariables(): string[] {
  return readdirSync(CONFIG_DOCS)
    .filter((file) => file.endsWith('.mdx'))
    .flatMap((file) => [
      ...readFileSync(join(CONFIG_DOCS, file), 'utf8').matchAll(/^### `([A-Z][A-Z0-9_]+)`/gm),
    ])
    .map((match) => match[1]!)
    .sort();
}

describe('environment-variable reference', () => {
  it('documents the complete runtime contract exactly once', () => {
    const schema = schemaEnvironmentVariables();
    const documented = documentedEnvironmentVariables();

    expect(new Set(documented).size, 'duplicate environment-variable headings').toBe(
      documented.length,
    );
    expect(documented).toEqual(schema);
  });

  it('does not hard-code a variable count that can drift from the schema', () => {
    const prose = [
      readFileSync(join(CONFIG_DOCS, 'index.mdx'), 'utf8'),
      readFileSync(REFERENCE_INDEX, 'utf8'),
    ].join('\n');

    expect(prose).not.toMatch(/\ball \d+ (?:discord-mcp )?(?:environment )?variables\b/i);
  });
});

describe('documentation navigation', () => {
  it('keeps every migration guide discoverable from the sidebar', () => {
    const sidebar = readFileSync(SIDEBAR_CONFIG, 'utf8');
    const routes = readdirSync(MIGRATION_DOCS)
      .filter((file) => file.endsWith('.mdx'))
      .map((file) =>
        file === 'index.mdx' ? "slug: 'migrate'" : `'migrate/${file.replace(/\.mdx$/, '')}'`,
      );

    for (const route of routes) {
      expect(sidebar, `${route} missing from sidebar`).toContain(route);
    }
  });

  it('makes the canonical connection-mode guide discoverable before setup', () => {
    const sidebar = readFileSync(SIDEBAR_CONFIG, 'utf8');
    const operations = readFileSync(OPERATIONS_INDEX, 'utf8');
    const setup = readFileSync(CLIENT_SETUP_DOC, 'utf8');

    expect(sidebar).toContain("{ label: 'Connection modes', slug: 'operations/clients' }");
    expect(operations).toContain(
      "{ title: 'Choose a connection mode', href: '/discord-mcp/operations/clients/'",
    );
    expect(setup).toContain('[choose a connection mode](/discord-mcp/operations/clients/)');
  });
});

describe('connection-mode guide', () => {
  it('keeps transport, tool surface, and Gateway choices independent and explicit', () => {
    const guide = readFileSync(CONNECTION_MODES_DOC, 'utf8');

    expect(guide).toContain('title: Choose a connection mode');
    for (const combination of [
      'Local stdio + progressive',
      'Local stdio + full',
      'Streamable HTTP + full',
      'Streamable HTTP + progressive',
    ]) {
      expect(guide, combination).toContain(combination);
    }

    expect(guide).toContain('Gateway is not a transport');
    expect(guide).toContain('4 visible tools');
    expect(guide).toContain('up to 205 visible tools');
    expect(guide).toContain('Guided `setup` defaults to `progressive`');
    expect(guide).toContain('Raw `serve` and legacy `init` default to `full`');
    expect(guide).toContain('HTTP does not support Gateway subscriptions');

    for (const route of [
      '/discord-mcp/start/client-setup/',
      '/discord-mcp/operations/openai/',
      '/discord-mcp/reference/config/access/',
      '/discord-mcp/architecture/gateway/',
      '/discord-mcp/recipes/gateway-subscribe/',
    ]) {
      expect(guide, route).toContain(route);
    }
  });
});
