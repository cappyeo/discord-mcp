import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { describe, expect, it, vi } from 'vitest';
import { WorkflowEngine } from './engine.js';
import { WorkflowStore } from './store.js';

const target = {
  profile_id: 'profile-main',
  bot_id: '1541991481491988572',
  guild_id: '123456789012345678',
};
const ok: CallToolResult = {
  isError: false,
  content: [{ type: 'text', text: 'ok' }],
  structuredContent: { ok: true },
};
const context = (
  invoke: (tool: string, args: unknown, signal: AbortSignal) => Promise<CallToolResult>,
  trustedTarget = target,
  authorizeStep?: (
    tool: string,
    args: Record<string, unknown>,
    target: typeof trustedTarget,
  ) => Promise<void>,
) => ({
  invoke,
  trustedTarget,
  ...(authorizeStep === undefined ? {} : { authorizeStep }),
});

async function waitForLockRelease(store: WorkflowStore, id: string): Promise<void> {
  await vi.waitFor(() => store.withLock(id, async () => undefined), {
    timeout: 5000,
    interval: 10,
  });
}

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'discord-mcp-workflow-'));
  const store = new WorkflowStore(dir, 'workflow-test-integrity-key-01234567890123456789');
  const engine = new WorkflowEngine({
    store,
    resolvePolicy: (tool) => ({
      idempotent: tool.endsWith('_read'),
      retry_safe: tool.endsWith('_read'),
    }),
  });
  return { dir, store, engine };
}

describe('WorkflowEngine', () => {
  it('requires review when an unsafe effect succeeds but its checkpoint write fails', async () => {
    const f = await fixture();
    const put = f.store.put.bind(f.store);
    let writes = 0;
    const invoke = vi.fn().mockResolvedValue(ok);
    const spy = vi.spyOn(f.store, 'put').mockImplementation(async (record) => {
      if (++writes === 4) throw new Error('Checkpoint replacement failed');
      await put(record);
    });
    try {
      const started = await f.engine.start(
        { target, steps: [{ tool: 'messages_send', args: {} }] },
        context(invoke),
      );

      await vi.waitFor(
        async () => {
          const record = await f.store.get(started.id);
          expect(record?.status).toBe('needs_review');
          expect(record?.failure?.code).toBe('WORKFLOW_ENGINE_ERROR');
        },
        { timeout: 10_000 },
      );
      await f.engine.resume(started.id, target, context(invoke));
      expect(invoke).toHaveBeenCalledOnce();
    } finally {
      spy.mockRestore();
      await rm(f.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

  it('persists before execution and returns an operation id immediately', async () => {
    const f = await fixture();
    try {
      let release!: (result: CallToolResult) => void;
      const gate = new Promise<CallToolResult>((resolve) => {
        release = resolve;
      });
      const result = await f.engine.start(
        { target, steps: [{ tool: 'messages_send', args: { content: 'x' } }] },
        context(async () => gate),
      );
      expect(result.id).toMatch(/^wf_[0-9a-f]{32}$/);
      expect(result.status).toBe('queued');
      expect((await f.store.get(result.id))?.steps[0]?.state).toBe('pending');
      release(ok);
      await vi.waitFor(
        async () => expect((await f.store.get(result.id))?.status).toBe('completed'),
        { timeout: 10_000 },
      );
    } finally {
      await rm(f.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

  it('rejects a malformed profile even when the trusted context matches it', async () => {
    const f = await fixture();
    const malformed = { profile_id: '../private' };
    try {
      await expect(
        f.engine.start(
          { target: malformed, steps: [{ tool: 'channels_read', args: {} }] },
          context(async () => ok, malformed as typeof target),
        ),
      ).rejects.toThrow(/trusted bot profile binding/);
    } finally {
      await rm(f.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

  it('rejects a bound channel step whose channel differs from the trusted target', async () => {
    const f = await fixture();
    const boundTarget = { ...target, channel_id: '111111111111111111' };
    try {
      await expect(
        f.engine.start(
          {
            target: boundTarget,
            steps: [{ tool: 'messages_send', args: { channel_id: '222222222222222222' } }],
          },
          context(async () => ok, boundTarget),
        ),
      ).rejects.toThrow(/target drift: channel_id/);
    } finally {
      await rm(f.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

  it('ignores a duplicate executor that observes a terminal checkpoint', async () => {
    const f = await fixture();
    let startedId = '';
    const get = f.store.get.bind(f.store);
    let reads = 0;
    const getSpy = vi.spyOn(f.store, 'get').mockImplementation(async (id) => {
      const record = await get(id);
      if (record !== undefined && reads++ === 0) return { ...record, status: 'completed' };
      return record;
    });
    try {
      const invoke = vi.fn().mockResolvedValue(ok);
      const started = await f.engine.start(
        { target, steps: [{ tool: 'channels_read', args: {} }] },
        context(invoke),
      );
      startedId = started.id;
      await vi.waitFor(() => expect(getSpy).toHaveBeenCalledOnce(), {
        timeout: 5000,
        interval: 10,
      });
      await waitForLockRelease(f.store, started.id);
      expect(invoke).not.toHaveBeenCalled();
      expect((await get(started.id))?.status).toBe('queued');
    } finally {
      getSpy.mockRestore();
      await waitForLockRelease(f.store, startedId);
      await rm(f.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

  it('marks an in-flight non-idempotent step for review after a fresh engine resumes', async () => {
    const f = await fixture();
    try {
      let release!: (result: CallToolResult) => void;
      const pending = new Promise<CallToolResult>((resolve) => {
        release = resolve;
      });
      const started = await f.engine.start(
        { target, steps: [{ tool: 'messages_send', args: { content: 'x' } }] },
        context(async () => pending),
      );
      for (
        let i = 0;
        i < 1000 && (await f.store.get(started.id))?.steps[0]?.state !== 'in_flight';
        i += 1
      )
        await new Promise((resolve) => setTimeout(resolve, 5));
      release(ok);
      for (
        let i = 0;
        i < 2000 && ['queued', 'running'].includes((await f.store.get(started.id))?.status ?? '');
        i += 1
      )
        await new Promise((resolve) => setTimeout(resolve, 5));
      const inFlight = await f.store.get(started.id);
      if (inFlight === undefined) throw new Error('checkpoint disappeared');
      await f.store.put({
        ...inFlight,
        status: 'running',
        current_step: 0,
        steps: [{ ...inFlight.steps[0]!, state: 'in_flight' }],
      });
      const fresh = new WorkflowEngine({
        store: f.store,
        resolvePolicy: () => ({ idempotent: false, retry_safe: false }),
      });
      const reviewed = await fresh.resume(
        started.id,
        target,
        context(async () => ok),
      );
      expect(reviewed.status).toBe('needs_review');
    } finally {
      await rm(f.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

  it('allows an explicit resume retry only for policy-declared idempotent steps', async () => {
    const f = await fixture();
    let startedId = '';
    try {
      const first = vi.fn().mockRejectedValueOnce(new Error('transient')).mockResolvedValue(ok);
      const started = await f.engine.start(
        { target, steps: [{ tool: 'channels_read', args: {} }] },
        context(first),
      );
      startedId = started.id;
      await vi.waitFor(
        async () =>
          expect((await f.store.get(started.id))?.failure?.code).toBe('WORKFLOW_STEP_THROWN'),
        { timeout: 5000, interval: 10 },
      );
      const failed = await f.store.get(started.id);
      expect(failed?.status).toBe('failed');
      expect(failed?.failure?.code).toBe('WORKFLOW_STEP_THROWN');
      expect(failed?.steps[0]?.state).toBe('in_flight');
      expect(failed?.steps[0]?.definition.idempotent).toBe(true);
      expect(failed?.steps[0]?.definition.retry_safe).toBe(true);
      const resumed = await f.engine.resume(started.id, target, context(first));
      expect(['queued', 'running', 'completed']).toContain(resumed.status);
      for (let i = 0; i < 1000 && (await f.store.get(started.id))?.status !== 'completed'; i += 1)
        await new Promise((resolve) => setTimeout(resolve, 10));
      expect((await f.store.get(started.id))?.status).toBe('completed');
      expect(first).toHaveBeenCalledTimes(2);
    } finally {
      await waitForLockRelease(f.store, startedId);
      await rm(f.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

  it('pauses before effect when the persisted retry policy changes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'discord-mcp-workflow-policy-'));
    let policyCalls = 0;
    const store = new WorkflowStore(dir, 'workflow-test-integrity-key-01234567890123456789');
    const invoke = vi.fn().mockResolvedValue(ok);
    const engine = new WorkflowEngine({
      store,
      resolvePolicy: () => {
        policyCalls += 1;
        return policyCalls === 1
          ? { idempotent: true, retry_safe: true }
          : { idempotent: false, retry_safe: false };
      },
    });
    try {
      const started = await engine.start(
        { target, steps: [{ tool: 'channels_read', args: {} }] },
        context(invoke),
      );
      for (let i = 0; i < 1000 && (await store.get(started.id))?.status !== 'needs_review'; i += 1)
        await new Promise((resolve) => setTimeout(resolve, 5));
      expect((await store.get(started.id))?.status).toBe('needs_review');
      expect(invoke).not.toHaveBeenCalled();
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

  it('rejects missing records and trusted-context drift for status/cancel/resume', async () => {
    const f = await fixture();
    try {
      await expect(f.engine.status('wf_0123456789abcdef0123456789abcdef', target)).rejects.toThrow(
        /Workflow not found/,
      );
      const started = await f.engine.start(
        { target, steps: [{ tool: 'channels_read', args: {} }] },
        context(async () => ok),
      );
      const wrongContext = context(async () => ok, { ...target, guild_id: '999999999999999999' });
      await expect(f.engine.status(started.id, target, wrongContext)).rejects.toThrow(
        /trusted server/,
      );
      await expect(f.engine.cancel(started.id, target, wrongContext)).rejects.toThrow(
        /trusted server/,
      );
      await expect(f.engine.resume(started.id, target, wrongContext)).rejects.toThrow(
        /trusted server/,
      );
    } finally {
      await rm(f.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

  it('rejects invalid definitions and unknown policies before persistence', async () => {
    const f = await fixture();
    try {
      await expect(
        new WorkflowEngine({
          store: f.store,
          resolvePolicy: (tool) =>
            tool === 'channels_read' ? { idempotent: true, retry_safe: true } : undefined,
        }).start(
          { target, steps: [{ id: 'Bad-ID', tool: 'channels_read', args: {} }] },
          context(async () => ok),
        ),
      ).rejects.toThrow(/Invalid workflow step id/);
      await expect(
        new WorkflowEngine({
          store: f.store,
          resolvePolicy: (tool) =>
            tool === 'channels_read' ? { idempotent: true, retry_safe: true } : undefined,
        }).start(
          { target, steps: [{ tool: 'unknown_tool', args: {} }] },
          context(async () => ok),
        ),
      ).rejects.toThrow(/Unknown workflow tool/);
      await expect(
        f.engine.start(
          {
            target: { profile_id: target.profile_id },
            steps: [{ tool: 'channels_read', args: { bot_id: target.bot_id } }],
          },
          context(async () => ok, { profile_id: target.profile_id }),
        ),
      ).rejects.toThrow(/cannot be verified/);
    } finally {
      await rm(f.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

  it('records known tool errors and aborts without replaying an uncertain effect', async () => {
    const f = await fixture();
    try {
      const invoke = vi.fn().mockResolvedValue({
        isError: true,
        content: [{ type: 'text', text: 'bad input' }],
        structuredContent: { code: 'VALIDATION_ERROR' },
      } satisfies CallToolResult);
      const started = await f.engine.start(
        { target, steps: [{ tool: 'messages_send', args: {} }] },
        context(invoke),
      );
      await vi.waitFor(async () => expect((await f.store.get(started.id))?.status).toBe('failed'), {
        timeout: 5000,
        interval: 10,
      });
      expect((await f.store.get(started.id))?.failure?.code).toBe('VALIDATION_ERROR');
      expect(invoke).toHaveBeenCalledOnce();
    } finally {
      await rm(f.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

  it('reviews a retriable Discord error when an idempotent write is not retry-safe', async () => {
    const f = await fixture();
    try {
      const invoke = vi.fn().mockResolvedValue({
        isError: true,
        content: [{ type: 'text', text: 'discord failure' }],
        structuredContent: { code: 'DISCORD_API_ERROR', retriable: true },
      } satisfies CallToolResult);
      const engine = new WorkflowEngine({
        store: f.store,
        resolvePolicy: (tool) =>
          tool === 'channels_read'
            ? { idempotent: true, retry_safe: false }
            : { idempotent: false, retry_safe: false },
      });
      const started = await engine.start(
        { target, steps: [{ tool: 'channels_read', args: {} }] },
        context(invoke),
      );
      await vi.waitFor(
        async () => expect((await f.store.get(started.id))?.status).toBe('needs_review'),
        {
          timeout: 5000,
          interval: 10,
        },
      );
      await waitForLockRelease(f.store, started.id);
      const resumed = await engine.resume(started.id, target, context(invoke));
      expect(resumed.status).toBe('needs_review');
      expect(invoke).toHaveBeenCalledOnce();
    } finally {
      await rm(f.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

  it('clears a prior safe read failure before completing its retry', async () => {
    const f = await fixture();
    let startedId = '';
    try {
      const invoke = vi
        .fn()
        .mockResolvedValueOnce({
          isError: true,
          content: [{ type: 'text', text: 'temporary' }],
          structuredContent: { code: 'DISCORD_API_ERROR', retriable: true },
        } satisfies CallToolResult)
        .mockResolvedValueOnce(ok);
      const started = await f.engine.start(
        { target, steps: [{ tool: 'channels_read', args: {} }] },
        context(invoke),
      );
      startedId = started.id;
      await vi.waitFor(async () => expect((await f.store.get(started.id))?.status).toBe('failed'), {
        timeout: 5000,
        interval: 10,
      });
      await waitForLockRelease(f.store, started.id);
      const resumed = await f.engine.resume(started.id, target, context(invoke));
      await vi.waitFor(
        async () => expect((await f.store.get(started.id))?.status).toBe('completed'),
        {
          timeout: 5000,
          interval: 10,
        },
      );
      expect(resumed.status).toBe('queued');
      expect((await f.store.get(started.id))?.failure).toBeUndefined();
      expect(invoke).toHaveBeenCalledTimes(2);
    } finally {
      await waitForLockRelease(f.store, startedId);
      await rm(f.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

  it('stops after a known scope rejection and does not invoke later steps', async () => {
    const f = await fixture();
    try {
      const invoke = vi.fn().mockResolvedValue({
        isError: true,
        content: [{ type: 'text', text: 'scope denied' }],
        structuredContent: { code: 'SCOPE_REJECTED' },
      } satisfies CallToolResult);
      const started = await f.engine.start(
        {
          target,
          steps: [
            { tool: 'channels_read', args: {} },
            { tool: 'channels_read', args: {} },
          ],
        },
        context(invoke),
      );
      await vi.waitFor(async () => expect((await f.store.get(started.id))?.status).toBe('failed'), {
        timeout: 5000,
        interval: 10,
      });
      expect((await f.store.get(started.id))?.failure?.code).toBe('SCOPE_REJECTED');
      expect(invoke).toHaveBeenCalledOnce();
    } finally {
      await rm(f.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

  it('rejects forged ids, target drift, traversal, nested execution, and oversized definitions', async () => {
    const f = await fixture();
    try {
      await expect(f.engine.status('../secrets', target)).rejects.toThrow(/Invalid workflow ID/);
      await expect(
        f.engine.start(
          { target, steps: [{ tool: 'mcp_pipeline', args: {} }] },
          context(async () => ok),
        ),
      ).rejects.toThrow(/Nested/);
      await expect(
        f.engine.start(
          { target: { profile_id: '../private' }, steps: [{ tool: 'channels_read', args: {} }] },
          context(async () => ok),
        ),
      ).rejects.toThrow(/trusted server/);
      await expect(
        f.engine.start(
          { target, steps: [{ tool: 'channels_read', args: { guild_id: '999999999999999999' } }] },
          context(async () => ok),
        ),
      ).rejects.toThrow(/target drift/);
      await expect(
        f.engine.start(
          {
            target,
            steps: Array.from({ length: 129 }, () => ({ tool: 'channels_read', args: {} })),
          },
          context(async () => ok),
        ),
      ).rejects.toThrow(/128/);
    } finally {
      await rm(f.dir, { recursive: true, force: true });
    }
  });

  it('cancels cooperatively during an effect and preserves the terminal cancellation', async () => {
    const f = await fixture();
    try {
      let release!: (result: CallToolResult) => void;
      const gate = new Promise<CallToolResult>((resolve) => {
        release = resolve;
      });
      const started = await f.engine.start(
        { target, steps: [{ tool: 'messages_send', args: { content: 'x' } }] },
        context(async () => gate),
      );
      for (
        let i = 0;
        i < 1000 && (await f.store.get(started.id))?.steps[0]?.state !== 'in_flight';
        i += 1
      )
        await new Promise((resolve) => setTimeout(resolve, 10));
      expect(
        (
          await f.engine.cancel(
            started.id,
            target,
            context(async () => ok),
          )
        ).status,
      ).toBe('cancel_requested');
      expect(
        (
          await f.engine.status(
            started.id,
            target,
            context(async () => ok),
          )
        ).status,
      ).toBe('cancel_requested');
      release(ok);
      for (let i = 0; i < 1000 && (await f.store.get(started.id))?.status !== 'cancelled'; i += 1)
        await new Promise((resolve) => setTimeout(resolve, 10));
      expect((await f.store.get(started.id))?.status).toBe('cancelled');
      expect(
        (
          await f.engine.cancel(
            started.id,
            target,
            context(async () => ok),
          )
        ).status,
      ).toBe('cancelled');
    } finally {
      await rm(f.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

  it('cancels a queued workflow from the persistent cancel flag before execution begins', async () => {
    const f = await fixture();
    let startedId = '';
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const enteredLock = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const withLock = f.store.withLock.bind(f.store);
    let first = true;
    const lockSpy = vi.spyOn(f.store, 'withLock').mockImplementation(async (id, fn) => {
      if (first) {
        first = false;
        entered();
        await held;
      }
      return withLock(id, fn);
    });
    try {
      const invoke = vi.fn().mockResolvedValue(ok);
      const started = await f.engine.start(
        { target, steps: [{ tool: 'messages_send', args: {} }] },
        context(invoke),
      );
      startedId = started.id;
      await enteredLock;
      expect((await f.engine.cancel(started.id, target, context(invoke))).status).toBe(
        'cancel_requested',
      );
      release();
      await vi.waitFor(
        async () => expect((await f.store.get(started.id))?.status).toBe('cancelled'),
        { timeout: 5000, interval: 10 },
      );
      expect(invoke).not.toHaveBeenCalled();
    } finally {
      release();
      lockSpy.mockRestore();
      await waitForLockRelease(f.store, startedId);
      await rm(f.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

  it('honors a persistent cancel flag between completed steps', async () => {
    const f = await fixture();
    let startedId = '';
    const put = f.store.put.bind(f.store);
    let requested = false;
    const putSpy = vi.spyOn(f.store, 'put').mockImplementation(async (record) => {
      await put(record);
      if (!requested && record.current_step === 1 && record.status === 'running') {
        requested = true;
        await f.store.requestCancel(record.id);
      }
    });
    try {
      const invoke = vi.fn().mockResolvedValue(ok);
      const started = await f.engine.start(
        {
          target,
          steps: [
            { tool: 'channels_read', args: {} },
            { tool: 'channels_read', args: {} },
          ],
        },
        context(invoke),
      );
      startedId = started.id;
      await vi.waitFor(
        async () => expect((await f.store.get(started.id))?.status).toBe('cancelled'),
        { timeout: 5000, interval: 10 },
      );
      expect(requested).toBe(true);
      expect(invoke).toHaveBeenCalledOnce();
      expect((await f.store.get(started.id))?.steps[0]?.state).toBe('success');
      expect((await f.store.get(started.id))?.steps[1]?.state).toBe('pending');
    } finally {
      putSpy.mockRestore();
      await waitForLockRelease(f.store, startedId);
      await rm(f.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

  it('marks a safe workflow failed when its terminal checkpoint cannot be written', async () => {
    const f = await fixture();
    let startedId = '';
    const put = f.store.put.bind(f.store);
    let writes = 0;
    const invoke = vi.fn().mockResolvedValue(ok);
    const spy = vi.spyOn(f.store, 'put').mockImplementation(async (record) => {
      if (++writes === 4) throw new Error('Checkpoint replacement failed');
      await put(record);
    });
    try {
      const started = await f.engine.start(
        { target, steps: [{ tool: 'channels_read', args: {} }] },
        context(invoke),
      );
      startedId = started.id;
      await vi.waitFor(
        async () => {
          const record = await f.store.get(started.id);
          expect(record?.status).toBe('failed');
          expect(record?.failure?.code).toBe('WORKFLOW_ENGINE_ERROR');
        },
        { timeout: 10_000 },
      );
      expect(invoke).toHaveBeenCalledOnce();
    } finally {
      spy.mockRestore();
      await waitForLockRelease(f.store, startedId);
      await rm(f.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

  it('skips a previously successful step when resuming from the next checkpoint', async () => {
    const f = await fixture();
    let startedId = '';
    try {
      const invoke = vi.fn().mockRejectedValueOnce(new Error('temporary')).mockResolvedValue(ok);
      const started = await f.engine.start(
        {
          target,
          steps: [
            { tool: 'channels_read', args: {} },
            { tool: 'channels_read', args: {} },
          ],
        },
        context(invoke),
      );
      startedId = started.id;
      await vi.waitFor(async () => expect((await f.store.get(started.id))?.status).toBe('failed'), {
        timeout: 5000,
        interval: 10,
      });
      await waitForLockRelease(f.store, started.id);
      const failed = await f.store.get(started.id);
      if (failed === undefined) throw new Error('checkpoint disappeared');
      await f.store.put({
        ...failed,
        status: 'queued',
        current_step: 0,
        steps: [{ ...failed.steps[0]!, state: 'success' }, failed.steps[1]!],
      });
      expect((await f.engine.resume(started.id, target, context(invoke))).status).toBe('queued');
      await vi.waitFor(
        async () => expect((await f.store.get(started.id))?.status).toBe('completed'),
        { timeout: 5000, interval: 10 },
      );
      expect(invoke).toHaveBeenCalledTimes(2);
    } finally {
      await waitForLockRelease(f.store, startedId);
      await rm(f.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

  it('resets a safe in-flight checkpoint and clears failure from a fresh engine', async () => {
    const f = await fixture();
    let startedId = '';
    try {
      const invoke = vi.fn().mockRejectedValueOnce(new Error('temporary')).mockResolvedValue(ok);
      const started = await f.engine.start(
        { target, steps: [{ tool: 'channels_read', args: {} }] },
        context(invoke),
      );
      startedId = started.id;
      await vi.waitFor(async () => expect((await f.store.get(started.id))?.status).toBe('failed'), {
        timeout: 5000,
        interval: 10,
      });
      await waitForLockRelease(f.store, started.id);
      const fresh = new WorkflowEngine({
        store: f.store,
        resolvePolicy: () => ({ idempotent: true, retry_safe: true }),
      });
      expect((await fresh.resume(started.id, target, context(invoke))).status).toBe('queued');
      await vi.waitFor(
        async () => expect((await f.store.get(started.id))?.status).toBe('completed'),
        { timeout: 5000, interval: 10 },
      );
      expect((await f.store.get(started.id))?.failure).toBeUndefined();
      expect(invoke).toHaveBeenCalledTimes(2);
    } finally {
      await waitForLockRelease(f.store, startedId);
      await rm(f.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

  it('records the cancellation message when an invocation throws AbortError', async () => {
    const f = await fixture();
    let startedId = '';
    try {
      const aborted = Object.assign(new Error('aborted'), { name: 'AbortError' });
      const invoke = vi.fn().mockRejectedValue(aborted);
      const started = await f.engine.start(
        { target, steps: [{ tool: 'messages_send', args: {} }] },
        context(invoke),
      );
      startedId = started.id;
      await vi.waitFor(
        async () => expect((await f.store.get(started.id))?.status).toBe('needs_review'),
        { timeout: 5000, interval: 10 },
      );
      expect((await f.store.get(started.id))?.failure?.message).toBe('Invocation cancelled.');
      expect(invoke).toHaveBeenCalledOnce();
    } finally {
      await waitForLockRelease(f.store, startedId);
      await rm(f.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

  it('requires review when resuming a failed step that is not retry-safe', async () => {
    const f = await fixture();
    let startedId = '';
    const invoke = vi.fn().mockResolvedValue({
      isError: true,
      content: [{ type: 'text', text: 'invalid' }],
      structuredContent: { code: 'VALIDATION_ERROR' },
    } satisfies CallToolResult);
    const engine = new WorkflowEngine({
      store: f.store,
      resolvePolicy: () => ({ idempotent: false, retry_safe: false }),
    });
    try {
      const started = await engine.start(
        { target, steps: [{ tool: 'messages_send', args: {} }] },
        context(invoke),
      );
      startedId = started.id;
      await vi.waitFor(async () => expect((await f.store.get(started.id))?.status).toBe('failed'), {
        timeout: 5000,
        interval: 10,
      });
      await waitForLockRelease(f.store, started.id);
      expect((await engine.resume(started.id, target, context(invoke))).status).toBe(
        'needs_review',
      );
      expect((await f.store.get(started.id))?.failure?.code).toBe('WORKFLOW_RETRY_REQUIRES_REVIEW');
      expect(invoke).toHaveBeenCalledOnce();
    } finally {
      await waitForLockRelease(f.store, startedId);
      await rm(f.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

  it.each([
    {
      name: 'a persisted bot target drift',
      originalTarget: target,
      args: { bot_id: target.bot_id },
      tamperedTarget: { ...target, bot_id: '999999999999999999' },
      expectedFailure: 'WORKFLOW_TARGET_REJECTED',
    },
    {
      name: 'a persisted unbound bot target',
      originalTarget: target,
      args: { bot_id: target.bot_id },
      tamperedTarget: {
        profile_id: target.profile_id,
        guild_id: target.guild_id,
      },
      expectedFailure: 'WORKFLOW_TARGET_REJECTED',
    },
    {
      name: 'a persisted channel target drift',
      originalTarget: { ...target, channel_id: '111111111111111111' },
      args: { channel_id: '111111111111111111' },
      tamperedTarget: { ...target, channel_id: '222222222222222222' },
      expectedFailure: 'WORKFLOW_TARGET_REJECTED',
    },
    {
      name: 'a persisted unbound channel target',
      originalTarget: { ...target, channel_id: '111111111111111111' },
      args: { channel_id: '111111111111111111' },
      tamperedTarget: { profile_id: target.profile_id, bot_id: target.bot_id },
      expectedFailure: 'WORKFLOW_TARGET_REJECTED',
    },
  ])('rejects $name before invoking the tool', async ({
    originalTarget,
    args,
    tamperedTarget,
    expectedFailure,
  }) => {
    const f = await fixture();
    let startedId = '';
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const enteredLock = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const withLock = f.store.withLock.bind(f.store);
    let first = true;
    const lockSpy = vi.spyOn(f.store, 'withLock').mockImplementation(async (id, fn) => {
      if (first) {
        first = false;
        entered();
        await held;
      }
      return withLock(id, fn);
    });
    try {
      const invoke = vi.fn().mockResolvedValue(ok);
      const started = await f.engine.start(
        { target: originalTarget, steps: [{ tool: 'channels_read', args }] },
        context(invoke, originalTarget),
      );
      startedId = started.id;
      await enteredLock;
      const record = await f.store.get(started.id);
      if (record === undefined) throw new Error('checkpoint disappeared');
      await f.store.put({ ...record, target: tamperedTarget });
      release();
      await vi.waitFor(async () => expect((await f.store.get(started.id))?.status).toBe('failed'), {
        timeout: 5000,
        interval: 10,
      });
      expect((await f.store.get(started.id))?.failure?.code).toBe(expectedFailure);
      expect(invoke).not.toHaveBeenCalled();
    } finally {
      release();
      lockSpy.mockRestore();
      await waitForLockRelease(f.store, startedId);
      await rm(f.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

  it('rejects active resume without resetting the running checkpoint', async () => {
    const f = await fixture();
    try {
      let release!: (result: CallToolResult) => void;
      const gate = new Promise<CallToolResult>((resolve) => {
        release = resolve;
      });
      const started = await f.engine.start(
        { target, steps: [{ tool: 'messages_send', args: { content: 'x' } }] },
        context(async () => gate),
      );
      for (
        let i = 0;
        i < 1000 && (await f.store.get(started.id))?.steps[0]?.state !== 'in_flight';
        i += 1
      )
        await new Promise((resolve) => setTimeout(resolve, 10));
      await expect(
        f.engine.resume(
          started.id,
          target,
          context(async () => ok),
        ),
      ).rejects.toThrow(/already being executed/);
      expect((await f.store.get(started.id))?.steps[0]?.state).toBe('in_flight');
      release(ok);
      for (let i = 0; i < 1000 && (await f.store.get(started.id))?.status === 'running'; i += 1)
        await new Promise((resolve) => setTimeout(resolve, 10));
    } finally {
      await rm(f.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

  it('never replays an uncertain non-idempotent error on resume', async () => {
    const f = await fixture();
    let startedId = '';
    try {
      const uncertain: CallToolResult = {
        isError: true,
        content: [{ type: 'text', text: 'upstream timeout' }],
        structuredContent: { code: 'DISCORD_TIMEOUT', retriable: true },
      };
      const invoke = vi.fn().mockResolvedValue(uncertain);
      const started = await f.engine.start(
        { target, steps: [{ tool: 'messages_send', args: { content: 'x' } }] },
        context(invoke),
      );
      startedId = started.id;
      for (let i = 0; i < 300 && (await f.store.get(started.id))?.status !== 'needs_review'; i += 1)
        await new Promise((resolve) => setTimeout(resolve, 10));
      expect((await f.store.get(started.id))?.status).toBe('needs_review');
      const resumed = await f.engine.resume(started.id, target, context(invoke));
      expect(resumed.status).toBe('needs_review');
      expect(invoke).toHaveBeenCalledOnce();
    } finally {
      await waitForLockRelease(f.store, startedId);
      await rm(f.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

  it('allows a guild-bound workflow to authorize multiple channels', async () => {
    const f = await fixture();
    try {
      const guildTarget = {
        profile_id: target.profile_id,
        bot_id: target.bot_id,
        guild_id: target.guild_id,
      };
      const invoke = vi.fn().mockResolvedValue(ok);
      const authorizeStep = vi.fn().mockResolvedValue(undefined);
      const started = await f.engine.start(
        {
          target: guildTarget,
          steps: [
            {
              tool: 'messages_send',
              args: { guild_id: target.guild_id, channel_id: '111111111111111111' },
            },
            {
              tool: 'messages_send',
              args: { guild_id: target.guild_id, channel_id: '222222222222222222' },
            },
          ],
        },
        context(invoke, guildTarget, authorizeStep),
      );
      for (let i = 0; i < 1000 && (await f.store.get(started.id))?.status !== 'completed'; i += 1)
        await new Promise((resolve) => setTimeout(resolve, 10));
      expect((await f.store.get(started.id))?.status).toBe('completed');
      expect(invoke).toHaveBeenCalledTimes(2);
      expect(authorizeStep).toHaveBeenCalledTimes(2);
    } finally {
      await rm(f.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

  it('rejects a cross-guild step before invoking it', async () => {
    const f = await fixture();
    try {
      const invoke = vi.fn().mockResolvedValue(ok);
      await expect(
        f.engine.start(
          {
            target,
            steps: [
              {
                tool: 'messages_send',
                args: { guild_id: '999999999999999999', channel_id: '111111111111111111' },
              },
            ],
          },
          context(invoke),
        ),
      ).rejects.toThrow(/target drift/);
      expect(invoke).not.toHaveBeenCalled();
    } finally {
      await rm(f.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

  it('fails closed for a channel step without a guild authorizer', async () => {
    const f = await fixture();
    try {
      await expect(
        f.engine.start(
          {
            target,
            steps: [{ tool: 'messages_send', args: { channel_id: '111111111111111111' } }],
          },
          context(async () => ok),
        ),
      ).rejects.toThrow(/trusted guild binding and step authorizer/);
    } finally {
      await rm(f.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

  it.each([
    'partial',
    'unverified',
  ])('reviews a %s composer delivery without continuing or replaying it', async (status) => {
    const f = await fixture();
    let startedId = '';
    try {
      const invoke = vi.fn().mockResolvedValue({
        isError: false,
        content: [{ type: 'text', text: 'partial' }],
        structuredContent: { status, sent_count: 0 },
      } satisfies CallToolResult);
      const started = await f.engine.start(
        {
          target,
          steps: [
            { tool: 'messages_publish', args: {} },
            { tool: 'messages_send', args: {} },
          ],
        },
        context(invoke),
      );
      startedId = started.id;
      for (let i = 0; i < 300 && (await f.store.get(started.id))?.status !== 'needs_review'; i += 1)
        await new Promise((resolve) => setTimeout(resolve, 10));
      expect((await f.store.get(started.id))?.status).toBe('needs_review');
      await waitForLockRelease(f.store, started.id);
      expect((await f.engine.resume(started.id, target, context(invoke))).status).toBe(
        'needs_review',
      );
      expect((await f.store.get(started.id))?.steps[1]?.state).toBe('pending');
      expect(invoke).toHaveBeenCalledOnce();
    } finally {
      await waitForLockRelease(f.store, startedId);
      await rm(f.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

  it('rejects an authorizer scope before invoking the tool', async () => {
    const f = await fixture();
    let startedId = '';
    try {
      const invoke = vi.fn().mockResolvedValue(ok);
      const authorize = vi.fn().mockRejectedValue(new Error('scope denied'));
      const started = await f.engine.start(
        {
          target: { ...target, guild_id: target.guild_id },
          steps: [
            {
              tool: 'messages_send',
              args: { guild_id: target.guild_id, channel_id: '111111111111111111' },
            },
          ],
        },
        context(invoke, target, authorize),
      );
      startedId = started.id;
      for (let i = 0; i < 1000 && (await f.store.get(started.id))?.status !== 'failed'; i += 1)
        await new Promise((resolve) => setTimeout(resolve, 10));
      expect((await f.store.get(started.id))?.failure?.code).toBe('WORKFLOW_TARGET_REJECTED');
      expect(invoke).not.toHaveBeenCalled();
    } finally {
      await waitForLockRelease(f.store, startedId);
      await rm(f.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });
});
