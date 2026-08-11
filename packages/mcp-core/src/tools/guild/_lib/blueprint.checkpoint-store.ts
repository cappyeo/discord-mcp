import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  chmod,
  link,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  stat,
  unlink,
} from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import {
  type BlueprintCheckpoint,
  BlueprintCheckpointSchema,
} from './blueprint.execution.schema.js';
import { canonicalJson } from './blueprint.validation.js';

const PLAN_ID_PATTERN = /^sha256:[a-f0-9]{64}$/;
const CHECKPOINT_FILE_PATTERN = /^checkpoint-v(\d+)\.json$/;
const LOCK_FILE_NAME = 'apply.lock';
const DEFAULT_STALE_LOCK_MS = 5 * 60 * 1_000;
const MAX_LOCK_BYTES = 4_096;

const LockRecordSchema = z
  .object({
    schema_version: z.literal('guild_blueprint_lock.v1'),
    plan_id: z.string().regex(PLAN_ID_PATTERN),
    nonce: z.string().regex(/^[a-f0-9]{32}$/),
    created_at_ms: z.number().int().nonnegative(),
    pid: z.number().int().positive(),
  })
  .strict();

type LockRecord = z.infer<typeof LockRecordSchema>;

const CheckpointEnvelopeSchema = z
  .object({
    schema_version: z.literal('guild_blueprint_checkpoint_envelope.v1'),
    checkpoint: BlueprintCheckpointSchema,
    auth_tag: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export type BlueprintCheckpointLock = {
  readonly acquired: true;
  heartbeat(): Promise<boolean>;
  release(): Promise<void>;
};

export type BlueprintCheckpointLockResult =
  | BlueprintCheckpointLock
  | { readonly acquired: false; readonly reason: 'busy' };

export class BlueprintCheckpointStoreError extends Error {
  readonly code:
    | 'INVALID_PLAN_ID'
    | 'INVALID_CHECKPOINT'
    | 'CHECKPOINT_MALFORMED'
    | 'CHECKPOINT_TAMPERED'
    | 'CHECKPOINT_VERSION_CONFLICT'
    | 'LOCK_MALFORMED'
    | 'CHECKPOINT_IO';

  constructor(
    code: BlueprintCheckpointStoreError['code'],
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'BlueprintCheckpointStoreError';
    this.code = code;
  }
}

function assertPlanId(planId: string): void {
  if (!PLAN_ID_PATTERN.test(planId)) {
    throw new BlueprintCheckpointStoreError(
      'INVALID_PLAN_ID',
      'plan_id must match sha256:<64 lowercase hexadecimal characters>',
    );
  }
}

function checkpointAuthTag(checkpoint: BlueprintCheckpoint, signingSecret: string): string {
  return createHmac('sha256', signingSecret)
    .update(`discord-mcp-blueprint-checkpoint.v1\0${canonicalJson(checkpoint)}`)
    .digest('hex');
}

function equalHex(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'hex');
  const rightBytes = Buffer.from(right, 'hex');
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'EPERM';
  }
}

function isUnsupportedChmod(error: unknown): boolean {
  if (process.platform === 'win32') return true;
  return (
    error instanceof Error && 'code' in error && ['EINVAL', 'ENOTSUP'].includes(String(error.code))
  );
}

async function chmodSecure(path: string, mode: number): Promise<void> {
  try {
    await chmod(path, mode);
  } catch (error) {
    if (!isUnsupportedChmod(error)) throw error;
  }
}

async function fsyncDirectory(path: string): Promise<void> {
  try {
    const handle = await open(path, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !('code' in error) ||
      !['EINVAL', 'ENOTSUP', 'EISDIR', 'EPERM'].includes(String(error.code))
    ) {
      throw error;
    }
  }
}

function checkpointVersionFromName(name: string): number | null {
  const match = CHECKPOINT_FILE_PATTERN.exec(name);
  if (match === null) return null;
  const version = Number(match[1]);
  return Number.isSafeInteger(version) && version >= 0 ? version : null;
}

function lockRecordFromText(text: string): LockRecord | null {
  try {
    const parsed = LockRecordSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

async function readLock(
  path: string,
): Promise<{ record: LockRecord; stat: Awaited<ReturnType<typeof stat>> } | null> {
  let lockStat: Awaited<ReturnType<typeof stat>>;
  try {
    lockStat = await stat(path);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }

  if (lockStat.size > MAX_LOCK_BYTES) return null;
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
  const record = lockRecordFromText(text);
  return record === null ? null : { record, stat: lockStat };
}

export interface BlueprintCheckpointStoreOptions {
  readonly stateDirectory: string;
  readonly planId: string;
  readonly signingSecret: string;
  readonly now?: () => number;
  readonly staleLockMs?: number;
}

/**
 * Local, append-only checkpoint state for one blueprint plan.
 * The plan itself is deliberately not persisted here.
 */
export class BlueprintCheckpointStore {
  readonly #stateDirectory: string;
  readonly #planId: string;
  readonly #planDirectory: string;
  readonly #lockPath: string;
  readonly #signingSecret: string;
  readonly #now: () => number;
  readonly #staleLockMs: number;

  constructor(options: BlueprintCheckpointStoreOptions) {
    // Validate before deriving any path from the caller-controlled plan id.
    assertPlanId(options.planId);
    if (options.stateDirectory.trim().length === 0) {
      throw new TypeError('stateDirectory must be a non-empty path');
    }
    if (options.signingSecret.length === 0) {
      throw new TypeError('signingSecret must be non-empty');
    }
    if (
      !Number.isFinite(options.staleLockMs ?? DEFAULT_STALE_LOCK_MS) ||
      (options.staleLockMs ?? DEFAULT_STALE_LOCK_MS) <= 0
    ) {
      throw new RangeError('staleLockMs must be a positive finite number');
    }
    this.#stateDirectory = options.stateDirectory;
    this.#planId = options.planId;
    this.#planDirectory = join(options.stateDirectory, options.planId.slice('sha256:'.length));
    this.#lockPath = join(this.#planDirectory, LOCK_FILE_NAME);
    this.#signingSecret = options.signingSecret;
    this.#now = options.now ?? Date.now;
    this.#staleLockMs = options.staleLockMs ?? DEFAULT_STALE_LOCK_MS;
  }

  get planId(): string {
    return this.#planId;
  }

  async load(): Promise<BlueprintCheckpoint | null> {
    let entries: string[];
    try {
      entries = await readdir(this.#planDirectory);
    } catch (error) {
      if (isMissing(error)) return null;
      throw new BlueprintCheckpointStoreError('CHECKPOINT_IO', 'Unable to list checkpoint state', {
        cause: error,
      });
    }

    const versions = entries
      .map(checkpointVersionFromName)
      .filter((version): version is number => version !== null)
      .sort((left, right) => right - left);
    const highest = versions[0];
    if (highest === undefined) return null;

    const path = join(this.#planDirectory, `checkpoint-v${highest}.json`);
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch (error) {
      throw new BlueprintCheckpointStoreError(
        'CHECKPOINT_MALFORMED',
        'Highest checkpoint could not be read',
        { cause: error },
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new BlueprintCheckpointStoreError(
        'CHECKPOINT_MALFORMED',
        'Highest checkpoint is not valid JSON',
        { cause: error },
      );
    }
    const envelope = CheckpointEnvelopeSchema.safeParse(parsed);
    if (!envelope.success) {
      throw new BlueprintCheckpointStoreError(
        'CHECKPOINT_MALFORMED',
        'Highest checkpoint failed envelope validation',
      );
    }
    const expectedTag = checkpointAuthTag(envelope.data.checkpoint, this.#signingSecret);
    if (!equalHex(envelope.data.auth_tag, expectedTag)) {
      throw new BlueprintCheckpointStoreError(
        'CHECKPOINT_TAMPERED',
        'Highest checkpoint authentication failed',
      );
    }
    const result = BlueprintCheckpointSchema.safeParse(envelope.data.checkpoint);
    if (
      !result.success ||
      result.data.plan_id !== this.#planId ||
      result.data.version !== highest
    ) {
      throw new BlueprintCheckpointStoreError(
        'CHECKPOINT_MALFORMED',
        'Highest checkpoint failed schema or identity validation',
      );
    }
    return result.data;
  }

  async save(checkpoint: BlueprintCheckpoint): Promise<void> {
    const result = BlueprintCheckpointSchema.safeParse(checkpoint);
    if (!result.success || result.data.plan_id !== this.#planId) {
      throw new BlueprintCheckpointStoreError(
        'INVALID_CHECKPOINT',
        'Checkpoint does not match this plan or schema',
      );
    }
    if (!Number.isSafeInteger(result.data.version)) {
      throw new BlueprintCheckpointStoreError(
        'INVALID_CHECKPOINT',
        'Checkpoint version must be a safe integer',
      );
    }

    await this.#ensureDirectory();
    const current = await this.load();
    if (current !== null && result.data.version <= current.version) {
      throw new BlueprintCheckpointStoreError(
        'CHECKPOINT_VERSION_CONFLICT',
        `Checkpoint version ${result.data.version} is not newer than ${current.version}`,
      );
    }

    const filename = `checkpoint-v${result.data.version}.json`;
    const destination = join(this.#planDirectory, filename);
    const temporary = join(
      this.#planDirectory,
      `.${filename}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`,
    );
    const payload = `${JSON.stringify({
      schema_version: 'guild_blueprint_checkpoint_envelope.v1',
      checkpoint: result.data,
      auth_tag: checkpointAuthTag(result.data, this.#signingSecret),
    })}\n`;
    let tempHandle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      tempHandle = await open(temporary, 'wx', 0o600);
      await tempHandle.writeFile(payload, 'utf8');
      await tempHandle.sync();
      await tempHandle.close();
      tempHandle = undefined;
      await chmodSecure(temporary, 0o600);

      // Hard-link publication is atomic and no-clobber. It is used instead of
      // rename because rename() replaces an existing destination on POSIX.
      try {
        await link(temporary, destination);
      } catch (error) {
        if (!isAlreadyExists(error) && !isLinkUnsupported(error)) throw error;
        if (isAlreadyExists(error)) {
          throw new BlueprintCheckpointStoreError(
            'CHECKPOINT_VERSION_CONFLICT',
            `Checkpoint version ${result.data.version} already exists`,
            { cause: error },
          );
        }
        // Filesystems without hard links still get the temp+rename protocol;
        // the per-plan lock and preflight keep versioned destinations unique.
        await assertAbsent(destination);
        await rename(temporary, destination);
      }
      await chmodSecure(destination, 0o600);
      await fsyncDirectory(this.#planDirectory);
    } catch (error) {
      if (error instanceof BlueprintCheckpointStoreError) throw error;
      throw new BlueprintCheckpointStoreError('CHECKPOINT_IO', 'Unable to write checkpoint', {
        cause: error,
      });
    } finally {
      if (tempHandle !== undefined) await tempHandle.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
    }
  }

  async tryAcquireLock(): Promise<BlueprintCheckpointLockResult> {
    await this.#ensureDirectory();
    const nonce = randomBytes(16).toString('hex');
    const record: LockRecord = {
      schema_version: 'guild_blueprint_lock.v1',
      plan_id: this.#planId,
      nonce,
      created_at_ms: this.#now(),
      pid: process.pid,
    };
    const payload = `${JSON.stringify(record)}\n`;

    try {
      const handle = await open(this.#lockPath, 'wx', 0o600);
      try {
        await handle.writeFile(payload, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await chmodSecure(this.#lockPath, 0o600);
      return this.#lease(record);
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
    }

    const existing = await readLock(this.#lockPath);
    if (existing === null || !this.#isStale(existing.record, existing.stat)) {
      return { acquired: false, reason: 'busy' };
    }

    // Re-read and compare the validated record/stat before unlinking. A
    // malformed or replaced lock is never reclaimed.
    const confirmed = await readLock(this.#lockPath);
    if (
      confirmed === null ||
      confirmed.record.nonce !== existing.record.nonce ||
      confirmed.record.plan_id !== this.#planId ||
      confirmed.stat.ino !== existing.stat.ino ||
      confirmed.stat.mtimeMs !== existing.stat.mtimeMs ||
      !this.#isStale(confirmed.record, confirmed.stat)
    ) {
      return { acquired: false, reason: 'busy' };
    }
    await unlink(this.#lockPath).catch((error) => {
      if (!isMissing(error)) throw error;
    });

    // A racing process may have won the lock after reclaim; retry once through
    // wx so we never report ownership without an exclusive create.
    try {
      const handle = await open(this.#lockPath, 'wx', 0o600);
      try {
        await handle.writeFile(payload, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await chmodSecure(this.#lockPath, 0o600);
      return this.#lease(record);
    } catch (error) {
      if (isAlreadyExists(error)) return { acquired: false, reason: 'busy' };
      throw error;
    }
  }

  async #ensureDirectory(): Promise<void> {
    await mkdir(this.#stateDirectory, { recursive: true, mode: 0o700 });
    await chmodSecure(this.#stateDirectory, 0o700);
    await mkdir(this.#planDirectory, { recursive: true, mode: 0o700 });
    await chmodSecure(this.#planDirectory, 0o700);
  }

  #isStale(record: LockRecord, lockStat: Awaited<ReturnType<typeof stat>>): boolean {
    const now = this.#now();
    const modifiedAt = Number(lockStat.mtimeMs);
    return (
      !isProcessAlive(record.pid) &&
      now >= record.created_at_ms &&
      now - record.created_at_ms >= this.#staleLockMs &&
      now >= modifiedAt &&
      now - modifiedAt >= this.#staleLockMs
    );
  }

  #lease(record: LockRecord): BlueprintCheckpointLock {
    let released = false;
    return {
      acquired: true,
      heartbeat: async () => {
        if (released) return false;
        let handle: Awaited<ReturnType<typeof open>>;
        try {
          handle = await open(this.#lockPath, 'r+');
        } catch (error) {
          if (isMissing(error)) return false;
          throw error;
        }
        try {
          const ownedStat = await handle.stat();
          if (ownedStat.size > MAX_LOCK_BYTES) return false;
          const currentRecord = lockRecordFromText(await handle.readFile('utf8'));
          if (
            currentRecord === null ||
            currentRecord.nonce !== record.nonce ||
            currentRecord.plan_id !== this.#planId
          ) {
            return false;
          }
          const now = new Date(this.#now());
          await handle.utimes(now, now);
          const current = await readLock(this.#lockPath);
          return (
            current !== null &&
            current.record.nonce === record.nonce &&
            current.record.plan_id === this.#planId &&
            current.stat.ino === ownedStat.ino
          );
        } finally {
          await handle.close();
        }
      },
      release: async () => {
        if (released) return;
        released = true;
        const current = await readLock(this.#lockPath);
        if (
          current === null ||
          current.record.nonce !== record.nonce ||
          current.record.plan_id !== this.#planId
        )
          return;
        await unlink(this.#lockPath).catch((error) => {
          if (!isMissing(error)) throw error;
        });
      },
    };
  }
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST';
}

function isLinkUnsupported(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    ['EPERM', 'ENOTSUP', 'EOPNOTSUPP'].includes(String(error.code))
  );
}

async function assertAbsent(path: string): Promise<void> {
  try {
    await stat(path);
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  throw new BlueprintCheckpointStoreError(
    'CHECKPOINT_VERSION_CONFLICT',
    'Checkpoint destination already exists',
  );
}
