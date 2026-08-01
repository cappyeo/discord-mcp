// FIXTURE: synthetic quadslab-style code for adapter testing - not real code.
// `templates` tools have no discord-mcp equivalent at cutoff -
// intentionally LEFT OUT of NAME_MAP; should appear in unmappedTools.
export const templateTools = [
  {
    name: 'list_templates',
    description: 'List server templates (no discord-mcp equivalent yet)',
    inputSchema: { type: 'object', properties: {} },
  },
];

export async function executeTemplateTool(name: string): Promise<unknown> {
  return { ok: true, name };
}
