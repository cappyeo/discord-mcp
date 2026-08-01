// FIXTURE: synthetic quadslab-style code for adapter testing - not real code.
// The adapter looks for: (a) `export const <category>Tools` array AND
// (b) `export function execute<Category>Tool` - both must appear in the
// same file. Tool names are extracted from `name: '<known>'` literals
// and intersected against the adapter's KNOWN_QUADSLAB_TOOLS set.

export const messageTools = [
  {
    name: 'send_message',
    description: 'Send a message to a Discord channel',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'edit_message',
    description: 'Edit a previously sent message',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_messages',
    description: 'Read recent messages from a channel',
    inputSchema: { type: 'object', properties: {} },
  },
];

export async function executeMessageTool(name: string): Promise<unknown> {
  // Synthetic stub - no real handler. The detection signal needs only
  // the function name to match `execute<Category>Tool`.
  return { ok: true, name };
}
