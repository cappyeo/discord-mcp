import { createHmac } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { WorkflowStore } from './store.js';
import type { WorkflowRecord } from './types.js';

const record: WorkflowRecord = {
  schema_version: 'workflow.v1',
  id: 'wf_0123456789abcdef0123456789abcdef',
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
  status: 'queued',
  target: { profile_id: 'profile' },
  target_fingerprint: 'sha256:test',
  steps: [],
  current_step: 0,
  cancel_requested: false,
};

describe('WorkflowStore', () => {
  it('uses private directory/files and atomic JSON replacement', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'discord-mcp-workflow-store-'));
    try {
      const store = new WorkflowStore(dir, 'workflow-test-integrity-key-01234567890123456789');
      await store.init();
      await store.put(record);
      if (process.platform !== 'win32') {
        expect((await stat(dir)).mode & 0o777).toBe(0o700);
        expect((await stat(join(dir, `${record.id}.json`))).mode & 0o777).toBe(0o600);
      }
      expect(JSON.parse(await readFile(join(dir, `${record.id}.json`), 'utf8')).record.id).toBe(
        record.id,
      );
      await expect(store.get('../x')).rejects.toThrow(/Invalid workflow ID/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('prevents two executors from holding one job lock', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'discord-mcp-workflow-lock-'));
    try {
      const store = new WorkflowStore(dir, 'workflow-test-integrity-key-01234567890123456789');
      await store.init();
      let release!: () => void;
      const held = store.withLock(
        record.id,
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      );
      for (let i = 0; i < 20 && release === undefined; i += 1)
        await new Promise((resolve) => setTimeout(resolve, 5));
      await expect(store.withLock(record.id, async () => undefined)).rejects.toThrow(
        /already being executed/,
      );
      release();
      await held;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects a tampered checkpoint', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'discord-mcp-workflow-tamper-'));
    try {
      const store = new WorkflowStore(dir, 'workflow-test-integrity-key-01234567890123456789');
      await store.init();
      await store.put(record);
      const path = join(dir, `${record.id}.json`);
      const value = JSON.parse(await readFile(path, 'utf8')) as {
        record: WorkflowRecord;
        mac: string;
      };
      value.record = { ...value.record, status: 'completed' };
      const { writeFile } = await import('node:fs/promises');
      await writeFile(path, JSON.stringify(value));
      await expect(store.get(record.id)).rejects.toThrow(/integrity/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects malformed checkpoint envelopes and a busy stale-lock recovery guard', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'discord-mcp-workflow-malformed-'));
    try {
      const store = new WorkflowStore(dir, 'workflow-test-integrity-key-01234567890123456789');
      await store.init();
      await writeFile(join(dir, `${record.id}.json`), JSON.stringify({ record }));
      await expect(store.get(record.id)).rejects.toThrow(/malformed/);
      await rm(join(dir, `${record.id}.json`), { force: true });
      await writeFile(join(dir, `${record.id}.lock`), '99999999\n');
      const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
        const error = new Error('dead') as NodeJS.ErrnoException;
        error.code = 'ESRCH';
        throw error;
      });
      await writeFile(join(dir, `${record.id}.lock.recover`), 'other\n');
      await expect(store.withLock(record.id, async () => undefined)).rejects.toThrow(
        /already being executed/,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects traversal for every file operation', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'discord-mcp-workflow-path-'));
    try {
      const store = new WorkflowStore(dir, 'workflow-test-integrity-key-01234567890123456789');
      await store.init();
      await expect(store.remove('../escape')).rejects.toThrow(/Invalid workflow ID/);
      await expect(store.withLock('../escape', async () => undefined)).rejects.toThrow(
        /Invalid workflow ID/,
      );
      await expect(store.requestCancel('../escape')).rejects.toThrow(/Invalid workflow ID/);
      await expect(store.isCancelRequested('../escape')).rejects.toThrow(/Invalid workflow ID/);
      await expect(store.clearCancel('../escape')).rejects.toThrow(/Invalid workflow ID/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects an undersized integrity key before creating durable state', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'discord-mcp-workflow-key-'));
    try {
      expect(() => new WorkflowStore(dir, 'too-short')).toThrow(/at least 32/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps concurrent readers on complete authenticated snapshots during writes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'discord-mcp-workflow-read-write-'));
    try {
      const store = new WorkflowStore(dir, 'workflow-test-integrity-key-01234567890123456789');
      await store.init();
      await store.put(record);
      const writes = Promise.all(
        Array.from({ length: 5 }, (_, index) =>
          store.put({
            ...record,
            updated_at: `2026-01-01T00:00:${String(index).padStart(2, '0')}.000Z`,
          }),
        ),
      );
      const reads = Promise.all(
        Array.from({ length: 10 }, async () => {
          const value = await store.get(record.id);
          expect(value?.id).toBe(record.id);
        }),
      );
      await Promise.all([writes, reads]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('tracks cancellation through the same checkpoint access queue', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'discord-mcp-workflow-cancel-'));
    try {
      const store = new WorkflowStore(dir, 'workflow-test-integrity-key-01234567890123456789');
      await store.init();
      expect(await store.isCancelRequested(record.id)).toBe(false);
      await store.requestCancel(record.id);
      expect(await store.isCancelRequested(record.id)).toBe(true);
      await store.clearCancel(record.id);
      expect(await store.isCancelRequested(record.id)).toBe(false);
      const cancelPath = join(dir, `${record.id}.cancel`);
      const { mkdir } = await import('node:fs/promises');
      await mkdir(cancelPath);
      await expect(store.isCancelRequested(record.id)).rejects.toThrow();
      await rm(cancelPath, { recursive: true, force: true });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('serializes same-id access across store instances and preserves authenticated snapshots', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'discord-mcp-workflow-cross-store-'));
    const key = 'workflow-test-integrity-key-01234567890123456789';
    try {
      const writer = new WorkflowStore(dir, key);
      const readerA = new WorkflowStore(dir, key);
      const readerB = new WorkflowStore(dir, key);
      await Promise.all([writer.init(), readerA.init(), readerB.init()]);
      await writer.put(record);
      const observed: string[] = [];
      const reads = [readerA, readerB].map(async (store) => {
        for (let round = 0; round < 50; round += 1) {
          const snapshot = await store.get(record.id);
          expect(snapshot?.id).toBe(record.id);
          observed.push(snapshot?.updated_at ?? '');
        }
      });
      const writes = (async () => {
        for (let index = 1; index <= 20; index += 1) {
          await writer.put({
            ...record,
            updated_at: `2026-01-01T00:00:${String(index).padStart(2, '0')}.000Z`,
          });
        }
      })();
      await Promise.all([...reads, writes]);
      expect(observed).toHaveLength(100);
      const final = await readerA.get(record.id);
      expect(final?.updated_at).toBe('2026-01-01T00:00:20.000Z');
      const envelope = JSON.parse(await readFile(join(dir, `${record.id}.json`), 'utf8')) as {
        record: WorkflowRecord;
        mac: string;
      };
      const expectedMac = createHmac('sha256', key)
        .update(JSON.stringify(envelope.record))
        .digest('hex');
      expect(envelope.mac).toBe(expectedMac);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('recovers after a queued read rejects a tampered snapshot', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'discord-mcp-workflow-read-recovery-'));
    const key = 'workflow-test-integrity-key-01234567890123456789';
    try {
      const first = new WorkflowStore(dir, key);
      const second = new WorkflowStore(dir, key);
      await Promise.all([first.init(), second.init()]);
      await first.put(record);
      const path = join(dir, `${record.id}.json`);
      const envelope = JSON.parse(await readFile(path, 'utf8')) as {
        record: WorkflowRecord;
        mac: string;
      };
      envelope.record = { ...envelope.record, status: 'completed' };
      await writeFile(path, JSON.stringify(envelope));
      await expect(second.get(record.id)).rejects.toThrow(/integrity/);
      await first.put({ ...record, updated_at: '2026-01-01T00:00:20.000Z' });
      await expect(second.get(record.id)).resolves.toMatchObject({
        status: 'queued',
        updated_at: '2026-01-01T00:00:20.000Z',
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('cleans a failed atomic write and keeps the same-id queue usable', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'discord-mcp-workflow-write-recovery-'));
    const key = 'workflow-test-integrity-key-01234567890123456789';
    try {
      const store = new WorkflowStore(dir, key);
      await store.init();
      await writeFile(join(dir, `${record.id}.json`), 'directory marker');
      await rm(join(dir, `${record.id}.json`));
      const { mkdir } = await import('node:fs/promises');
      await mkdir(join(dir, `${record.id}.json`));
      await expect(store.put(record)).rejects.toThrow();
      expect((await readdir(dir)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
      await rm(join(dir, `${record.id}.json`), { recursive: true, force: true });
      await store.put({ ...record, updated_at: '2026-01-01T00:00:20.000Z' });
      await expect(store.get(record.id)).resolves.toMatchObject({
        id: record.id,
        updated_at: '2026-01-01T00:00:20.000Z',
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('cleans a recovery marker when a stale lock owner changes during recovery', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'discord-mcp-workflow-lock-race-'));
    const lockPath = join(dir, `${record.id}.lock`);
    try {
      const store = new WorkflowStore(dir, 'workflow-test-integrity-key-01234567890123456789');
      await store.init();
      await writeFile(lockPath, '99999999\n');
      let firstProbe = true;
      const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
        if (firstProbe) {
          firstProbe = false;
          writeFileSync(lockPath, '99999998\n');
        }
        const error = new Error('dead') as NodeJS.ErrnoException;
        error.code = 'ESRCH';
        throw error;
      });
      await expect(store.withLock(record.id, async () => undefined)).rejects.toThrow(
        /already being executed/,
      );
      expect(await readFile(`${lockPath}.recover`).catch(() => undefined)).toBeUndefined();
      kill.mockRestore();
    } finally {
      vi.restoreAllMocks();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('allows only one concurrent executor to recover a stale lock', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'discord-mcp-workflow-stale-lock-'));
    try {
      const store = new WorkflowStore(dir, 'workflow-test-integrity-key-01234567890123456789');
      await store.init();
      await writeFile(join(dir, `${record.id}.lock`), '99999999\n');
      const kill = vi.spyOn(process, 'kill').mockImplementation((pid) => {
        if (pid === process.pid) return true;
        const error = new Error('dead') as NodeJS.ErrnoException;
        error.code = 'ESRCH';
        throw error;
      });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let entered!: () => void;
      const acquired = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const first = store.withLock(record.id, () => {
        entered();
        return gate;
      });
      try {
        // Wait for the first executor, not the pre-existing stale PID file.
        // Its real PID must remain alive in the probe used by the contender.
        await Promise.race([acquired, first]);
        await expect(store.withLock(record.id, async () => undefined)).rejects.toThrow(
          /already being executed/,
        );
      } finally {
        release();
        try {
          await first;
        } finally {
          kill.mockRestore();
        }
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
