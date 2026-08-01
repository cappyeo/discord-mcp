// FIXTURE: synthetic discord-ops-style code for adapter testing - not real code.
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

export const listChannels = defineTool({
  name: 'list_channels',
  description: 'List all channels in a guild (synthetic fixture).',
  category: 'channels',
  inputSchema,
  handle: async () => ({ ok: true }),
});

export const setSlowmode = defineTool({
  name: 'set_slowmode',
  description: 'Set rate-limit-per-user on a channel.',
  category: 'channels',
  inputSchema,
  handle: async () => ({ ok: true }),
});
