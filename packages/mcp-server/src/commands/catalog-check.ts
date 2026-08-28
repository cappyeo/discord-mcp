import { buildCatalogServer } from '@discord-mcp/core';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';

const EXPECTED_TOOL_COUNT = 209;
const EXPECTED_TOOL_NAMES = [
  'guild_blueprint_plan',
  'guild_blueprint_apply',
  'guild_blueprint_evidence',
  'messages_send',
] as const;
const EXPECTED_RESOURCE_URIS = [
  'discord://components-v2/schema',
  'discord://components-v2/templates/announcement',
  'discord://components-v2/templates/incident_status',
  'discord://components-v2/templates/poll_results',
  'discord://components-v2/templates/release_notes',
  'discord://components-v2/templates/welcome_card',
] as const;

export interface CatalogCheckData {
  schema_version: 'discord-mcp.catalog-check.v1';
  tool_count: number;
  resource_count: number;
  execution_guard: 'CATALOG_ONLY';
  credentials_required: false;
  discord_execution: 'disabled';
  activity_evidence_created: false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertUniqueExact(actual: string[], expected: readonly string[], label: string): void {
  if (new Set(actual).size !== actual.length) {
    throw new Error(`${label} contains duplicate entries`);
  }
  if (actual.length !== expected.length || expected.some((entry) => !actual.includes(entry))) {
    throw new Error(`${label} does not match the packaged contract`);
  }
}

function assertCatalogOnly(result: unknown, label: string): void {
  if (!isRecord(result) || result.isError !== true || !isRecord(result.structuredContent)) {
    throw new Error(`${label} did not fail through the catalog guard`);
  }
  const content = result.structuredContent;
  if (
    content.code !== 'CATALOG_ONLY' ||
    content.retriable !== false ||
    content.category !== 'client'
  ) {
    throw new Error(`${label} returned an invalid catalog guard result`);
  }
}

function assertToolSchemas(tools: readonly unknown[]): void {
  for (const value of tools) {
    if (!isRecord(value) || typeof value.name !== 'string') {
      throw new Error('tools/list returned invalid tool metadata');
    }
    const tool = value;
    if (typeof tool.description !== 'string' || tool.description.trim() === '') {
      throw new Error(`tools/list returned missing metadata for ${tool.name}`);
    }
    if (!isRecord(tool.inputSchema) || tool.inputSchema.type !== 'object') {
      throw new Error(`tools/list returned an invalid input schema for ${tool.name}`);
    }
    if (!isRecord(tool.outputSchema) || tool.outputSchema.type !== 'object') {
      throw new Error(`tools/list returned an invalid output schema for ${tool.name}`);
    }
  }
}

/** Verify the installed, credential-free catalog contract without Discord I/O. */
export async function runCatalogCheck(): Promise<CatalogCheckData> {
  const built = await buildCatalogServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client(
    { name: 'discord-mcp-catalog-check', version: '1.0.0' },
    { capabilities: {} },
  );

  try {
    await Promise.all([built.server.connect(serverTransport), client.connect(clientTransport)]);

    const [{ tools }, { resources }] = await Promise.all([
      client.listTools(),
      client.listResources(),
    ]);
    const toolNames = tools.map((tool) => tool.name);
    if (toolNames.length !== EXPECTED_TOOL_COUNT) {
      throw new Error('tools/list does not match the packaged contract');
    }
    assertToolSchemas(tools);
    assertUniqueExact(toolNames, built.registeredTools, 'tools/list');
    for (const toolName of EXPECTED_TOOL_NAMES) {
      if (!toolNames.includes(toolName)) {
        throw new Error(`tools/list is missing required tool ${toolName}`);
      }
    }

    const resourceUris = resources.map((resource) => resource.uri);
    assertUniqueExact(resourceUris, EXPECTED_RESOURCE_URIS, 'resources/list');
    const resourceReads = await Promise.all(
      EXPECTED_RESOURCE_URIS.map((uri) => client.readResource({ uri })),
    );
    for (const [index, resource] of resourceReads.entries()) {
      const content = resource.contents[0];
      if (
        resource.contents.length !== 1 ||
        content?.mimeType !== 'application/json' ||
        !('text' in content) ||
        typeof content.text !== 'string'
      ) {
        throw new Error(
          `resources/read returned invalid content for ${EXPECTED_RESOURCE_URIS[index]}`,
        );
      }
      JSON.parse(content.text);
    }

    const [listedCall, unknownCall] = await Promise.all([
      client.callTool({ name: 'messages_send', arguments: {} }),
      client.callTool({ name: 'unknown_catalog_tool', arguments: {} }),
    ]);
    assertCatalogOnly(listedCall, 'listed tool call');
    assertCatalogOnly(unknownCall, 'unknown tool call');

    return {
      schema_version: 'discord-mcp.catalog-check.v1',
      tool_count: toolNames.length,
      resource_count: resourceUris.length,
      execution_guard: 'CATALOG_ONLY',
      credentials_required: false,
      discord_execution: 'disabled',
      activity_evidence_created: false,
    };
  } finally {
    await Promise.allSettled([
      client.close(),
      built.server.close(),
      built.auditSink.shutdown?.() ?? Promise.resolve(),
    ]);
  }
}
