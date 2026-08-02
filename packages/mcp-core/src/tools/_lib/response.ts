import type { CallToolResult } from '@modelcontextprotocol/server';

export interface DualResultOpts<T> {
  text: string;
  data: T;
  truncated?: {
    reason: string;
    cursor?: string;
    full_count?: number;
  };
}

export function dualResult<T>(opts: DualResultOpts<T>): CallToolResult {
  let text = opts.text;
  if (opts.truncated) {
    text += `\n\n_${opts.truncated.reason}_`;
    if (opts.truncated.cursor) {
      text += ` Resume with \`cursor:"${opts.truncated.cursor}"\`.`;
    }
    if (opts.truncated.full_count !== undefined) {
      text += ` (${opts.truncated.full_count} total available)`;
    }
  }
  return {
    isError: false,
    content: [{ type: 'text', text }],
    structuredContent: opts.data as Record<string, unknown>,
  };
}
