// FIXTURE: synthetic discord-ops-style code for adapter testing - not real code.
// `system` tools are discord-ops-specific introspection helpers and are
// intentionally LEFT OUT of NAME_MAP - they should appear in the migrate()
// unmappedTools list.
import type { ZodTypeAny } from 'zod';

type ToolDefinition = {
  name: string;
  description: string;
  category: string;
  inputSchema: ZodTypeAny;
  handle: (input: unknown, ctx: unknown) => Promise<unknown>;
};

function defineTool(t: ToolDefinition): ToolDefinition {
  return t;
}

const inputSchema = { _def: 'fixture' } as unknown as ZodTypeAny;

export const healthCheck = defineTool({
  name: 'health_check',
  description: 'Report runtime health (no discord-mcp equivalent - gateway client).',
  category: 'system',
  inputSchema,
  handle: async () => ({ ok: true }),
});

export const listProjects = defineTool({
  name: 'list_projects',
  description: 'List configured projects (no discord-mcp equivalent).',
  category: 'system',
  inputSchema,
  handle: async () => ({ ok: true }),
});
