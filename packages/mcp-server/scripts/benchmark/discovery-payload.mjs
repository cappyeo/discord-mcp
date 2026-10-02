import assert from 'node:assert/strict';
import { buildServer, createLogger, loadConfig } from '@discord-mcp/core';
import { REST } from '@discordjs/rest';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';

const config = loadConfig({
  DISCORD_TOKEN: 'Bot fake.test.token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  LOG_LEVEL: 'fatal',
  MCP_AUDIT_ENABLED: 'false',
  MCP_TOOL_SURFACE: 'progressive',
});

const REST_MESSAGE = {
  id: '999000999000999000',
  channel_id: '112233445566778899',
  content: 'hello from the local discovery payload probe',
  author: { id: '111122223333444401', username: 'alice', global_name: 'Alice' },
  timestamp: '2026-04-28T12:00:00.000000+00:00',
  edited_timestamp: null,
  pinned: false,
};
const restMethods = [];
const rest = new REST({
  version: '10',
  makeRequest: async (url, init) => {
    restMethods.push(init.method ?? 'GET');
    if (init.method !== 'GET') throw new Error(`unexpected REST method: ${init.method}`);
    if (!url.includes('/channels/112233445566778899/messages/999000999000999000')) {
      throw new Error(`unexpected REST URL: ${url}`);
    }
    return new Response(JSON.stringify(REST_MESSAGE), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  },
}).setToken('fake-token');

const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const built = await buildServer({ rest, logger: createLogger(config), config });
const client = new Client(
  { name: 'discovery-payload-probe', version: '0.0.0' },
  { capabilities: {} },
);
await Promise.all([built.server.connect(serverTransport), client.connect(clientTransport)]);

const serializedBytes = (value) => Buffer.byteLength(JSON.stringify(value), 'utf8');
const legacy = {
  advertised: await client.listTools(),
  browse: await client.callTool({ name: 'mcp_tools_search', arguments: {} }),
  fuzzy: await client.callTool({
    name: 'mcp_tools_search',
    arguments: { query: 'send a message', limit: 8 },
  }),
  exact: await client.callTool({
    name: 'mcp_tools_search',
    arguments: { query: 'messages_send' },
  }),
  dispatcher: await client.callTool({
    name: 'mcp_tools_read',
    arguments: { tool: 'messages_send', args: {} },
  }),
};
const useful = {
  advertised: await client.listTools(),
  fuzzy: await client.callTool({
    name: 'mcp_tools_search',
    arguments: { query: 'get a message', limit: 8 },
  }),
  exact: await client.callTool({
    name: 'mcp_tools_search',
    arguments: { query: 'messages_get' },
  }),
  dispatcher: await client.callTool({
    name: 'mcp_tools_read',
    arguments: {
      tool: 'messages_get',
      args: { channel_id: REST_MESSAGE.channel_id, message_id: REST_MESSAGE.id },
    },
  }),
};

assert.equal(built.registeredTools.length, 221);
assert.equal(legacy.advertised.tools.length, 7);
assert.equal(legacy.browse.structuredContent.categories.length, 31);
assert.equal(Object.hasOwn(legacy.fuzzy.structuredContent, 'categories'), false);
assert.equal(Object.hasOwn(legacy.exact.structuredContent, 'categories'), false);
assert.equal(legacy.exact.structuredContent.matches[0].name, 'messages_send');
assert.ok(useful.fuzzy.structuredContent.matches.some(({ name }) => name === 'messages_get'));
assert.equal(useful.exact.structuredContent.matches[0].name, 'messages_get');
assert.ok(useful.exact.structuredContent.matches[0].inputSchema);
assert.equal(useful.dispatcher.isError, false);
assert.equal(useful.dispatcher.structuredContent.message_id, REST_MESSAGE.id);
assert.deepEqual(restMethods, ['GET']);

const metricsFor = (responses) =>
  Object.fromEntries(
    Object.entries(responses).map(([name, response]) => [
      name,
      {
        bytes: serializedBytes(response),
        structured_bytes:
          response.structuredContent === undefined
            ? null
            : serializedBytes(response.structuredContent),
        content_bytes: response.content === undefined ? null : serializedBytes(response.content),
      },
    ]),
  );
const legacyMetrics = metricsFor(legacy);
const usefulMetrics = metricsFor(useful);
const workflowBytes = (metrics) =>
  ['advertised', 'fuzzy', 'exact', 'dispatcher'].reduce(
    (total, name) => total + metrics[name].bytes,
    0,
  );

process.stdout.write(
  `${JSON.stringify({
    schema_version: 'discord-mcp.discovery-payload.v1',
    legacy: { workflow_bytes: workflowBytes(legacyMetrics), metrics: legacyMetrics },
    useful: { workflow_bytes: workflowBytes(usefulMetrics), metrics: usefulMetrics },
  })}\n`,
);

await client.close();
