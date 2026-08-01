// FIXTURE: synthetic quadslab-style code for adapter testing - not real code.
// `presence` tools are gateway-only and intentionally LEFT OUT of
// NAME_MAP - they should appear in the migrate() unmappedTools list.
export const presenceTools = [
  {
    name: 'set_bot_status',
    description: 'Set the bot presence (gateway only, no REST equivalent)',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_bot_info',
    description: 'Get the running bot user info (gateway only)',
    inputSchema: { type: 'object', properties: {} },
  },
];

export async function executePresenceTool(name: string): Promise<unknown> {
  return { ok: true, name };
}
