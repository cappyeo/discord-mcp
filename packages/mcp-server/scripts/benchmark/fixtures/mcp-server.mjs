import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';

const server = new McpServer({ name: 'benchmark-fixture', version: '1.0.0' });

for (const name of ['guild_blueprint_plan', 'guild_blueprint_apply', 'guild_blueprint_evidence']) {
  server.registerTool(name, { description: 'Benchmark transport fixture' }, async () => ({
    content: [{ type: 'text', text: 'fixture' }],
    structuredContent: { status: 'fixture', tool: name },
  }));
}

await server.connect(new StdioServerTransport());
