import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Resolve every runtime module from the clean tarball consumer, not the workspace.
const consumer = resolve(process.argv[2]);
const requireFromConsumer = createRequire(join(consumer, 'package.json'));
const fromConsumer = (name) => import(pathToFileURL(requireFromConsumer.resolve(name)).href);
const [{ buildServer, createLogger, loadConfig }, { REST }, { Client }, { InMemoryTransport }] =
  await Promise.all([
    fromConsumer('@discord-mcp/core'),
    fromConsumer('@discordjs/rest'),
    fromConsumer('@modelcontextprotocol/client'),
    fromConsumer('@modelcontextprotocol/server'),
  ]);

let restRequests = 0;
const config = loadConfig({
  DISCORD_TOKEN: `Bot ${'a'.repeat(60)}`,
  LOG_LEVEL: 'fatal',
  MCP_AUDIT_ENABLED: 'false',
  MCP_TOOL_SURFACE: 'progressive',
  MCP_CATEGORIES: 'templates',
});
const rest = new REST({
  version: '10',
  makeRequest: async () => {
    restRequests += 1;
    throw new Error('packaged lazy catalog probe must not contact Discord');
  },
}).setToken('fake-token');
const built = await buildServer({ rest, logger: createLogger(config), config });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: 'packaged-lazy-catalog-probe', version: '0.0.0' });

try {
  await Promise.all([built.server.connect(serverTransport), client.connect(clientTransport)]);
  await client.listTools();
  const request = {
    name: 'mcp_tools_read',
    arguments: { tool: 'templates_recommend', args: { request: 'zzzxxyyqq' } },
  };
  const results = await Promise.all([client.callTool(request), client.callTool(request)]);
  for (const result of results) {
    assert.notEqual(result.isError, true, JSON.stringify(result));
    assert.equal(result.structuredContent.status, 'no_match');
    assert.equal(
      result.structuredContent.catalog_version,
      'd48cec3acf16c56138b7c303d711717aabc11b0e5813865b8926c2d6952212fe',
    );
    assert.equal(result.structuredContent.verification.catalog_records, 4_970);
    assert.equal(result.structuredContent.verification.rest_requests, 0);
  }
  assert.equal(restRequests, 0);
  process.stdout.write('ok packaged lazy catalog: 4,970 records, concurrent first use, no REST\n');
} finally {
  await client.close();
  await built.server.close();
}
