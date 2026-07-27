import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it, vi } from 'vitest';
import mcpPipeline from './pipeline.js';

const ok = (data: Record<string, unknown>): CallToolResult => ({
  isError: false,
  content: [{ type: 'text', text: 'ok' }],
  structuredContent: data,
});

describe('mcp_pipeline tool', () => {
  it('exposes correct metadata', () => {
    const T = mcpPipeline;
    const t = new T(
      { name: 'mcp_pipeline', path: 'inline', root: 'inline', store: null as never },
      { name: 'mcp_pipeline', enabled: true },
    );
    expect(t.name).toBe('mcp_pipeline');
    expect(t.category).toBe('meta');
    expect(t.annotations.openWorldHint).toBe(true);
  });

  it('refuses recursive mcp_pipeline calls (no nested pipelines)', async () => {
    const T = mcpPipeline;
    const t = new T(
      { name: 'mcp_pipeline', path: 'inline', root: 'inline', store: null as never },
      { name: 'mcp_pipeline', enabled: true },
    );
    const invoke = vi.fn();
    const result = (await t.run(
      { steps: [{ id: 'nest', tool: 'mcp_pipeline', args: { steps: [] } }] },
      { signal: new AbortController().signal, invoke } as never,
    )) as {
      isError?: boolean;
      structuredContent?: {
        aborted: boolean;
        steps: Array<{ status: string; error?: { code: string } }>;
      };
    };
    expect(result.structuredContent?.aborted).toBe(true);
    expect(result.structuredContent?.steps[0]?.status).toBe('error');
    expect(result.structuredContent?.steps[0]?.error?.code).toBe('PIPELINE_RECURSION');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('forwards each step to the injected invoke function', async () => {
    const T = mcpPipeline;
    const t = new T(
      { name: 'mcp_pipeline', path: 'inline', root: 'inline', store: null as never },
      { name: 'mcp_pipeline', enabled: true },
    );
    const invoke = vi.fn().mockResolvedValue(ok({ count: 3 }));
    const result = (await t.run(
      {
        steps: [
          {
            id: '115759770816628172',
            tool: 'channels_list',
            args: { guild_id: '416150631470215224' },
          },
          {
            id: '637012073593481124',
            tool: 'roles_list',
            args: { guild_id: '416150631470215224' },
          },
        ],
      },
      { signal: new AbortController().signal, invoke } as never,
    )) as { structuredContent: { steps: Array<{ id: string; status: string }> } };
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke.mock.calls[0]![0]).toBe('channels_list');
    expect(invoke.mock.calls[1]![0]).toBe('roles_list');
    expect(result.structuredContent.steps).toHaveLength(2);
    expect(result.structuredContent.steps.every((s) => s.status === 'success')).toBe(true);
  });
});
