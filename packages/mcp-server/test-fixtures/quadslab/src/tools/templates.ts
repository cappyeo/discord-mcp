// FIXTURE: synthetic quadslab-style code for adapter testing - not real code.
// `templates` tools map to discord-mcp's native Guild Template surface.
export const templateTools = [
  {
    name: 'list_templates',
    description: 'List server templates',
    inputSchema: { type: 'object', properties: {} },
  },
];

export async function executeTemplateTool(name: string): Promise<unknown> {
  return { ok: true, name };
}
