import type { Tool as McpTool } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';
import {
  createProgressiveToolCatalog,
  PROGRESSIVE_SEARCH_TOOL,
  searchProgressiveTools,
} from './tool-discovery.js';

function tool(name: string, description: string): McpTool {
  return {
    name,
    description,
    annotations: { readOnlyHint: true },
    inputSchema: { type: 'object', properties: {} },
  } as McpTool;
}

describe('progressive tool catalog metadata', () => {
  it('makes the repeated category index optional in the search contract', () => {
    const successSchema = (PROGRESSIVE_SEARCH_TOOL.outputSchema as { anyOf: unknown[] })
      .anyOf[0] as {
      required: string[];
    };
    expect(successSchema.required).not.toContain('categories');
  });

  it('keeps authorization-specific categories isolated when metadata is reused', () => {
    const shared = tool('messages_read', 'Read messages');
    const first = createProgressiveToolCatalog([shared], new Map([['messages_read', 'alpha']]));
    const second = createProgressiveToolCatalog([shared], new Map([['messages_read', 'beta']]));

    expect(first.categories).toEqual([{ name: 'alpha', tool_count: 1 }]);
    expect(second.categories).toEqual([{ name: 'beta', tool_count: 1 }]);
    expect(second.byCategory.get('beta')?.[0]?.category).toBe('beta');
  });

  it('refreshes cached metadata when a tool changes', () => {
    const mutable = tool('messages_read', 'Read messages');
    const before = createProgressiveToolCatalog(
      [mutable],
      new Map([['messages_read', 'messages']]),
    );

    mutable.name = 'channels_list';
    mutable.description = 'List channels';
    const after = createProgressiveToolCatalog([mutable], new Map([['channels_list', 'channels']]));

    expect(before.byExactQuery.has('messages read')).toBe(true);
    expect(after.byExactQuery.has('channels list')).toBe(true);
    expect(after.categories).toEqual([{ name: 'channels', tool_count: 1 }]);
    const result = searchProgressiveTools({ query: 'channels list', detail: 'compact' }, after);
    expect(result.structuredContent).toMatchObject({
      matches: [expect.objectContaining({ name: 'channels_list', summary: 'List channels' })],
    });
  });

  it('does not touch lazy input schemas for compact multi-match results', () => {
    let schemaReads = 0;
    const first = tool('messages_read', 'Read messages');
    const second = tool('messages_search', 'Search messages');
    Object.defineProperty(first, 'inputSchema', {
      get() {
        schemaReads += 1;
        throw new Error('compact search should not load input schemas');
      },
    });
    Object.defineProperty(second, 'inputSchema', {
      get() {
        schemaReads += 1;
        throw new Error('compact search should not load input schemas');
      },
    });
    const catalog = createProgressiveToolCatalog(
      [first, second],
      new Map([
        ['messages_read', 'messages'],
        ['messages_search', 'messages'],
      ]),
    );

    const result = searchProgressiveTools(
      { query: 'messages', detail: 'compact', limit: 2 },
      catalog,
    );

    expect(result.isError).not.toBe(true);
    expect(schemaReads).toBe(0);
    expect(result.structuredContent).toMatchObject({
      matches: [
        expect.objectContaining({ name: 'messages_read' }),
        expect.objectContaining({ name: 'messages_search' }),
      ],
    });
  });
});
