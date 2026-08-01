// FIXTURE: synthetic discord-ops-style code for adapter testing - not real code.
// The adapter's detect() looks for: (a) `defineTool(` call AND (b) a
// `category: '<cat>'` field somewhere in the same file. Tool names are
// extracted from `name: '<known>'` literals and intersected against the
// adapter's KNOWN_DISCORD_OPS_TOOLS set.
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

// Synthetic Zod stub - fixture does not depend on the real zod package
// at type-check time; the adapter only reads source text.
const inputSchema = { _def: 'fixture' } as unknown as ZodTypeAny;

export const sendMessage = defineTool({
  name: 'send_message',
  description: 'Send a message to a Discord channel (synthetic fixture).',
  category: 'messaging',
  inputSchema,
  handle: async () => ({ ok: true }),
});

export const getMessages = defineTool({
  name: 'get_messages',
  description: 'Fetch recent messages from a Discord channel.',
  category: 'messaging',
  inputSchema,
  handle: async () => ({ ok: true }),
});

export const editMessage = defineTool({
  name: 'edit_message',
  description: 'Edit a previously sent message.',
  category: 'messaging',
  inputSchema,
  handle: async () => ({ ok: true }),
});
