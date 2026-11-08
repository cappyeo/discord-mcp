import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { link, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { WORKFLOW_ID_RE, type WorkflowRecord } from './types.js';

const checkpointAccess = new Map<string, Promise<void>>();

/** Keep this process's readers from holding a Windows file open during replacement. */
async function withCheckpointAccess<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const previous = checkpointAccess.get(path) ?? Promise.resolve();
  const result = previous.then(operation);
  const settled = result.then(
    () => undefined,
    () => undefined,
  );
  checkpointAccess.set(path, settled);
  try {
    return await result;
  } finally {
    if (checkpointAccess.get(path) === settled) checkpointAccess.delete(path);
  }
}

function assertJobId(id: string): void {
  if (!WORKFLOW_ID_RE.test(id)) throw new Error('Invalid workflow ID.');
}

export class WorkflowBusyError extends Error {
  public constructor() {
    super('Workflow is already being executed.');
    this.name = 'WorkflowBusyError';
  }
}

async function atomicRename(source: string, destination: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(source, destination);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY'].includes(code ?? '') || attempt >= 5) {
        await rm(source, { force: true }).catch(() => undefined);
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 50 * 2 ** attempt));
    }
  }
}

export class WorkflowStore {
  public readonly directory: string;

  public constructor(
    directory: string,
    private readonly integrityKey: string,
  ) {
    if (integrityKey.length < 32)
      throw new Error('Workflow integrity key must be at least 32 characters.');
    this.directory = resolve(directory);
  }

  public async init(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    // mkdir's mode is affected by umask and is a no-op for an existing path.
    const { chmod } = await import('node:fs/promises');
    await chmod(this.directory, 0o700);
  }

  private path(id: string): string {
    assertJobId(id);
    return join(this.directory, `${id}.json`);
  }

  private lockPath(id: string): string {
    assertJobId(id);
    return join(this.directory, `${id}.lock`);
  }

  private cancelPath(id: string): string {
    assertJobId(id);
    return join(this.directory, `${id}.cancel`);
  }

  public async requestCancel(id: string): Promise<void> {
    const destination = this.cancelPath(id);
    return withCheckpointAccess(destination, async () => {
      const temporary = `${destination}.${randomUUID()}.tmp`;
      await writeFile(temporary, `${Date.now()}\n`, { mode: 0o600 });
      await atomicRename(temporary, destination);
    });
  }

  public async isCancelRequested(id: string): Promise<boolean> {
    const destination = this.cancelPath(id);
    return withCheckpointAccess(destination, async () => {
      try {
        await readFile(destination);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
      }
    });
  }

  public async clearCancel(id: string): Promise<void> {
    const destination = this.cancelPath(id);
    await withCheckpointAccess(destination, () => rm(destination, { force: true }));
  }

  public async get(id: string): Promise<WorkflowRecord | undefined> {
    const destination = this.path(id);
    return withCheckpointAccess(destination, async () => {
      try {
        const envelope = JSON.parse(await readFile(destination, 'utf8')) as {
          record?: WorkflowRecord;
          mac?: string;
        };
        if (envelope.record === undefined || typeof envelope.mac !== 'string')
          throw new Error('Workflow checkpoint is malformed.');
        const expected = createHmac('sha256', this.integrityKey)
          .update(JSON.stringify(envelope.record))
          .digest('hex');
        if (
          envelope.mac.length !== expected.length ||
          !timingSafeEqual(Buffer.from(envelope.mac), Buffer.from(expected))
        )
          throw new Error('Workflow checkpoint integrity check failed.');
        return envelope.record;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      }
    });
  }

  public idForStartKey(key: string): string {
    const digest = createHmac('sha256', this.integrityKey)
      .update('discord-mcp-workflow-start.v1\0')
      .update(key)
      .digest('hex');
    return `wf_${digest.slice(0, 32)}`;
  }

  /** Publish a complete signed checkpoint before any runner can use it. */
  public async create(record: WorkflowRecord): Promise<boolean> {
    return this.writeCheckpoint(record, true);
  }

  public async put(record: WorkflowRecord): Promise<void> {
    await this.writeCheckpoint(record, false);
  }

  private async writeCheckpoint(record: WorkflowRecord, createOnly: boolean): Promise<boolean> {
    const destination = this.path(record.id);
    return withCheckpointAccess(destination, async () => {
      const temporary = `${destination}.${randomUUID()}.tmp`;
      const mac = createHmac('sha256', this.integrityKey)
        .update(JSON.stringify(record))
        .digest('hex');
      await writeFile(temporary, `${JSON.stringify({ record, mac })}\n`, { mode: 0o600 });
      if (!createOnly) {
        await atomicRename(temporary, destination);
        return true;
      }
      try {
        await link(temporary, destination);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
        throw error;
      } finally {
        await rm(temporary, { force: true }).catch(() => undefined);
      }
    });
  }

  public async remove(id: string): Promise<void> {
    const destination = this.path(id);
    await withCheckpointAccess(destination, () => rm(destination, { force: true }));
  }

  /** Hold an exclusive per-job lock for one executor attempt. */
  public async withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const lockPath = this.lockPath(id);
    const recoveryPath = `${lockPath}.recover`;
    let handle: Awaited<ReturnType<typeof open>>;
    let recovery: Awaited<ReturnType<typeof open>> | undefined;
    for (;;) {
      try {
        handle = await open(lockPath, 'wx', 0o600);
        await handle.writeFile(`${process.pid}\n`);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        try {
          const owner = Number.parseInt(await readFile(lockPath, 'utf8'), 10);
          if (!Number.isInteger(owner) || owner <= 0) throw new Error('invalid owner');
          try {
            process.kill(owner, 0);
          } catch (probeError) {
            if ((probeError as NodeJS.ErrnoException).code !== 'ESRCH') throw probeError;
            recovery = await open(recoveryPath, 'wx', 0o600);
            const confirmed = Number.parseInt(await readFile(lockPath, 'utf8'), 10);
            if (confirmed !== owner) throw new Error('lock owner changed');
            try {
              process.kill(confirmed, 0);
              throw new Error('lock owner is active');
            } catch (secondProbe) {
              if ((secondProbe as NodeJS.ErrnoException).code !== 'ESRCH') throw secondProbe;
            }
            await rm(lockPath, { force: true });
            await recovery.close();
            recovery = undefined;
            await rm(recoveryPath, { force: true });
            continue;
          }
        } catch {
          if (recovery !== undefined) {
            await recovery.close().catch(() => undefined);
            recovery = undefined;
            await rm(recoveryPath, { force: true }).catch(() => undefined);
          }
          throw new WorkflowBusyError();
        }
        throw new WorkflowBusyError();
      }
    }
    try {
      return await fn();
    } finally {
      await handle.close();
      await rm(this.lockPath(id), { force: true });
    }
  }
}
