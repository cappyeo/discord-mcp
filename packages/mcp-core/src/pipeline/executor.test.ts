import type { CallToolResult } from '@modelcontextprotocol/server';
import { describe, expect, it, vi } from 'vitest';
import { executePipeline, type PipelineExecutorCtx } from './executor.js';

const ok = (data: Record<string, unknown>): CallToolResult => ({
  isError: false,
  content: [{ type: 'text', text: 'ok' }],
  structuredContent: data,
});

const err = (code: string, message: string): CallToolResult => ({
  isError: true,
  content: [{ type: 'text', text: message }],
  structuredContent: { code, retriable: false, category: 'client' },
});

describe('executePipeline', () => {
  const baseCtx: PipelineExecutorCtx = { signal: new AbortController().signal };

  it('runs a single step and captures result under step id', async () => {
    const invoke = vi.fn().mockResolvedValue(ok({ message_id: 'm1' }));
    const result = await executePipeline(
      [{ id: 'send', tool: 'messages_send', args: { channel_id: 'c1', content: 'hi' } }],
      invoke,
      baseCtx,
    );
    expect(result.aborted).toBe(false);
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]!.status).toBe('success');
    expect(result.steps[0]!.id).toBe('send');
    expect(result.variables.send).toEqual({ message_id: 'm1' });
    expect(invoke).toHaveBeenCalledWith(
      'messages_send',
      { channel_id: 'c1', content: 'hi' },
      baseCtx.signal,
    );
  });

  it('interpolates variables from earlier steps into later step args', async () => {
    const invoke = vi
      .fn()
      .mockResolvedValueOnce(ok({ messages: [{ id: 'msg_1' }] }))
      .mockResolvedValueOnce(ok({ deleted: true, message_id: 'msg_1' }));
    const result = await executePipeline(
      [
        { id: 'read', tool: 'messages_read', args: { channel_id: 'c1' } },
        {
          id: 'del',
          tool: 'messages_delete',
          args: { channel_id: 'c1', message_id: '{{read.messages[0].id}}' },
        },
      ],
      invoke,
      baseCtx,
    );
    expect(result.aborted).toBe(false);
    expect(invoke.mock.calls[1]![1]).toEqual({ channel_id: 'c1', message_id: 'msg_1' });
  });

  it('save_as aliases the result under both step id and the alias', async () => {
    const invoke = vi.fn().mockResolvedValue(ok({ count: 7 }));
    const result = await executePipeline(
      [{ id: 'count', tool: 'channels_list', args: { guild_id: 'g1' }, save_as: 'channels' }],
      invoke,
      baseCtx,
    );
    expect(result.variables.count).toEqual({ count: 7 });
    expect(result.variables.channels).toEqual({ count: 7 });
  });

  it('skips a step whose `if` resolves falsy', async () => {
    const invoke = vi
      .fn()
      .mockResolvedValueOnce(ok({ count: 0 }))
      .mockResolvedValueOnce(ok({ message_id: 'm2' }));
    const result = await executePipeline(
      [
        { id: 'first', tool: 'channels_list', args: { guild_id: 'g1' } },
        {
          id: 'maybe',
          tool: 'messages_send',
          args: { channel_id: 'c1', content: 'hi' },
          if: '{{first.count}}',
        },
      ],
      invoke,
      baseCtx,
    );
    expect(result.steps[1]!.status).toBe('skipped');
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('aborts the pipeline when a step fails (default continue_on_error: false)', async () => {
    const invoke = vi
      .fn()
      .mockResolvedValueOnce(ok({ messages: [] }))
      .mockResolvedValueOnce(err('DISCORD_PERMISSION_DENIED', 'no perm'))
      .mockResolvedValueOnce(ok({ never: 'reached' }));
    const result = await executePipeline(
      [
        { id: 'a', tool: 'messages_read', args: {} },
        { id: 'b', tool: 'messages_send', args: { content: 'x' } },
        { id: 'c', tool: 'messages_send', args: { content: 'y' } },
      ],
      invoke,
      baseCtx,
    );
    expect(result.aborted).toBe(true);
    expect(result.steps).toHaveLength(2);
    expect(result.steps[0]!.status).toBe('success');
    expect(result.steps[1]!.status).toBe('error');
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it('continues past a failed step when continue_on_error is true', async () => {
    const invoke = vi
      .fn()
      .mockResolvedValueOnce(err('DISCORD_NOT_FOUND', 'gone'))
      .mockResolvedValueOnce(ok({ ok: true }));
    const result = await executePipeline(
      [
        { id: 'a', tool: 'messages_delete', args: {}, continue_on_error: true },
        { id: 'b', tool: 'messages_send', args: {} },
      ],
      invoke,
      baseCtx,
    );
    expect(result.aborted).toBe(false);
    expect(result.steps[0]!.status).toBe('error');
    expect(result.steps[1]!.status).toBe('success');
  });

  it('default-ids unnamed steps as step_<index>', async () => {
    const invoke = vi.fn().mockResolvedValue(ok({ ok: true }));
    const result = await executePipeline(
      [
        { tool: 'messages_send', args: { content: 'a' } },
        { tool: 'messages_send', args: { content: 'b' } },
      ],
      invoke,
      baseCtx,
    );
    expect(result.steps[0]!.id).toBe('step_0');
    expect(result.steps[1]!.id).toBe('step_1');
    expect(result.variables.step_0).toEqual({ ok: true });
  });

  it('records duration_ms per step (>= 0)', async () => {
    const invoke = vi.fn().mockResolvedValue(ok({}));
    const result = await executePipeline([{ id: 'a', tool: 'x', args: {} }], invoke, baseCtx);
    expect(result.steps[0]!.duration_ms).toBeGreaterThanOrEqual(0);
    expect(typeof result.total_duration_ms).toBe('number');
  });

  it('captures error code + retriable from a failed CallToolResult', async () => {
    const invoke = vi.fn().mockResolvedValue(err('DISCORD_RATE_LIMITED', 'wait'));
    const result = await executePipeline([{ id: 'a', tool: 'x', args: {} }], invoke, baseCtx);
    expect(result.steps[0]!.error?.code).toBe('DISCORD_RATE_LIMITED');
    expect(result.steps[0]!.error?.retriable).toBe(false);
  });

  it('aborts pipeline if signal is already aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    const invoke = vi.fn();
    const result = await executePipeline([{ id: 'a', tool: 'x', args: {} }], invoke, {
      signal: ac.signal,
    });
    expect(result.aborted).toBe(true);
    expect(result.steps).toHaveLength(0);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('stops before the next step when the signal aborts mid-pipeline', async () => {
    const ac = new AbortController();
    const invoke = vi.fn().mockImplementation(async () => {
      ac.abort();
      return ok({ ok: true });
    });
    const result = await executePipeline(
      [
        { id: 'a', tool: 'messages_send', args: { content: 'x' } },
        { id: 'b', tool: 'messages_send', args: { content: 'y' } },
      ],
      invoke,
      { signal: ac.signal },
    );
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(result.aborted).toBe(true);
    expect(result.steps).toHaveLength(1);
  });
});
