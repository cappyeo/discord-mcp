import { beforeAll, describe, expect, it } from 'vitest';
import {
  createProgressiveToolCatalog,
  searchProgressiveTools,
} from '../../packages/mcp-core/src/tool-discovery.js';
import { loadAllTools } from './generate-tool-docs.js';

const COMPOSER_TOOLS = ['messages_compose', 'messages_publish', 'messages_update'] as const;

let tools: Awaited<ReturnType<typeof loadAllTools>>;
let catalog: ReturnType<typeof createProgressiveToolCatalog>;

describe('rich message composer catalog contract', () => {
  beforeAll(async () => {
    tools = await loadAllTools();
    const mcpTools = tools as unknown as Parameters<typeof createProgressiveToolCatalog>[0];
    catalog = createProgressiveToolCatalog(
      mcpTools,
      new Map(mcpTools.map((tool) => [tool.name, 'messages'])),
    );
  }, 120_000);

  it('registers all composer tools while retaining the plain message tool', async () => {
    const names = tools.map((tool) => tool.name);

    expect(tools).toHaveLength(222);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual(expect.arrayContaining([...COMPOSER_TOOLS, 'messages_send']));

    for (const name of COMPOSER_TOOLS) {
      const tool = tools.find((candidate) => candidate.name === name);
      expect(tool?.category).toBe('messages');
      expect(tool?.description.toLowerCase()).toContain('announcement');
      expect(tool?.annotations).toBeDefined();
    }
  });

  it.each([
    ['compose announcement', 'messages_compose'],
    ['send embed file poll', 'messages_publish'],
    ['update announcement', 'messages_update'],
  ])('makes %s discoverable as %s', async (query, expectedName) => {
    const result = searchProgressiveTools({ query, limit: 8, detail: 'full' }, catalog);
    const matches = (result.structuredContent as { matches: Array<{ name: string }> }).matches;

    expect(result.isError).toBe(false);
    expect(matches.map((match) => match.name)).toContain(expectedName);
  });

  it('keeps messages_send available for plain text continuity', async () => {
    const result = searchProgressiveTools({ query: 'messages_send', detail: 'full' }, catalog);
    const matches = (result.structuredContent as { matches: Array<{ name: string }> }).matches;

    expect(matches[0]?.name).toBe('messages_send');
  });
});
