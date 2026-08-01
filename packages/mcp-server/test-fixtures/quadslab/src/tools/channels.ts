// FIXTURE: synthetic quadslab-style code for adapter testing - not real code.
export const channelTools = [
  {
    name: 'list_channels',
    description: 'List all channels in a guild',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'create_text_channel',
    description: 'Create a new text channel',
    inputSchema: { type: 'object', properties: {} },
  },
];

export async function executeChannelTool(name: string): Promise<unknown> {
  return { ok: true, name };
}
