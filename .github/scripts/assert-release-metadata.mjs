import { readFileSync } from 'node:fs';

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

const cli = readJson('packages/mcp-server/package.json');
const core = readJson('packages/mcp-core/package.json');
const mocks = readJson('packages/mcp-server-mocks/package.json');
const site = readJson('site/package.json');
const server = readJson('server.json');
const expectedTag = `v${cli.version}`;
const releaseTag = process.env.RELEASE_TAG;

const checks = [
  [
    releaseTag === expectedTag,
    `release tag must be ${expectedTag}, received ${releaseTag ?? '(unset)'}`,
  ],
  [core.version === cli.version, 'core and CLI versions must match'],
  [mocks.version === cli.version, 'server-mocks and CLI versions must match'],
  [site.version === cli.version, 'site and CLI versions must match'],
  [server.version === cli.version, 'server.json and CLI versions must match'],
  [
    server.packages?.[0]?.version === cli.version,
    'server.json npm package and CLI versions must match',
  ],
  [server.name === cli.mcpName, 'server.json name and CLI mcpName must match'],
  [
    server.packages?.[0]?.identifier === cli.name,
    'server.json package identifier and CLI name must match',
  ],
];

const failures = checks.filter(([ok]) => !ok).map(([, message]) => message);
if (failures.length > 0) {
  for (const failure of failures) console.error(`FAIL: ${failure}`);
  process.exit(1);
}

process.stdout.write(`ok ${cli.name}@${cli.version} (${server.name})\n`);
