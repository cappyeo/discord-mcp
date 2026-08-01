// FIXTURE: synthetic discord-ops-style code for adapter testing - not real code.
// This module simulates a private-fork that exposes `messages_lite` /
// `messages_full` profile-variant tools. NAME_MAP folds them onto the
// same discord-mcp tool (messages_send) with confidence: medium plus a
// note pointing at the file header's "Architectural mismatches" #2.
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

export const messagesLite = defineTool({
  name: 'messages_lite',
  description: 'Profile-variant: lite messaging (synthetic fixture).',
  category: 'messaging',
  inputSchema,
  handle: async () => ({ ok: true }),
});
