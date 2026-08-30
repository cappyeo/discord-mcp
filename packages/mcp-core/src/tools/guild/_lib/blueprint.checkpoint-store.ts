import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import {
  chmod,
  copyFile,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  unlink,
} from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import {
  assertGuildBlueprintActivityEvidence,
  type GuildBlueprintActivityEvidence,
  GuildBlueprintActivityEvidenceSchema,
} from './blueprint.activity-evidence.js';
import {
  type BlueprintCheckpoint,
  BlueprintCheckpointSchema,
} from './blueprint.execution.schema.js';
import { canonicalJson } from './blueprint.validation.js';

const PLAN_ID_PATTERN = /^sha256:[a-f0-9]{64}$/;
const CHECKPOINT_FILE_PATTERN = /^checkpoint-v(\d+)\.json$/;
const LOCK_FILE_NAME = 'apply.lock';
const ACTIVITY_EVIDENCE_FILE_NAME = 'activity-evidence.json';
// A dead local owner is safe to reclaim after a short termination grace. Live
// owners remain protected by the PID check regardless of lock age.
const DEFAULT_STALE_LOCK_MS = 15_000;
const MAX_LOCK_BYTES = 4_096;
const MAX_CHECKPOINT_BYTES = 1_048_576;
const MAX_ACTIVITY_EVIDENCE_BYTES = 1_048_576;

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

const ActivityEvidenceEnvelopeSchema = z
  .object({
    schema_version: z.literal('guild_blueprint_activity_evidence_envelope.v1'),
    evidence: GuildBlueprintActivityEvidenceSchema,
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
    | 'CHECKPOINT_UNSAFE'
    | 'CHECKPOINT_TAMPERED'
    | 'CHECKPOINT_VERSION_CONFLICT'
    | 'INVALID_EVIDENCE'
    | 'EVIDENCE_MALFORMED'
    | 'EVIDENCE_UNSAFE'
    | 'EVIDENCE_TAMPERED'
    | 'EVIDENCE_CONFLICT'
    | 'EVIDENCE_IO'
    | 'LOCK_MALFORMED'
    | 'LOCK_UNSAFE'
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

function activityEvidenceAuthTag(
  evidence: GuildBlueprintActivityEvidence,
  signingSecret: string,
): string {
  return createHmac('sha256', signingSecret)
    .update(`discord-mcp-blueprint-activity-evidence.v1\0${canonicalJson(evidence)}`)
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

type FileMetadata = Awaited<ReturnType<typeof lstat>>;

function sameFileIdentity(expected: FileMetadata, actual: FileMetadata): boolean {
  if (expected.ino !== actual.ino || expected.ino === 0) return false;
  if (expected.dev === actual.dev) return true;
  return process.platform === 'win32' && (expected.dev === 0 || actual.dev === 0);
}

async function inspectDirectory(
  path: string,
  unsafeCode: BlueprintCheckpointStoreError['code'],
): Promise<boolean> {
  let metadata: FileMetadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new BlueprintCheckpointStoreError(unsafeCode, 'Blueprint state directory is unsafe.');
  }
  return true;
}

interface BoundedFileRead {
  readonly bytes: Buffer;
  readonly stat: FileMetadata;
}

async function readBoundedRegularFile(
  path: string,
  maxBytes: number,
  codes: {
    readonly unsafe: BlueprintCheckpointStoreError['code'];
    readonly nonFile: BlueprintCheckpointStoreError['code'];
    readonly malformed: BlueprintCheckpointStoreError['code'];
    readonly io: BlueprintCheckpointStoreError['code'];
  },
): Promise<BoundedFileRead | null> {
  let metadata: FileMetadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if (isMissing(error)) return null;
    throw new BlueprintCheckpointStoreError(codes.io, 'Blueprint state could not be inspected.', {
      cause: error,
    });
  }
  if (metadata.isSymbolicLink()) {
    throw new BlueprintCheckpointStoreError(codes.unsafe, 'Blueprint state file is unsafe.');
  }
  if (!metadata.isFile()) {
    throw new BlueprintCheckpointStoreError(codes.nonFile, 'Blueprint state path is not a file.');
  }
  if (metadata.size > maxBytes) {
    throw new BlueprintCheckpointStoreError(codes.malformed, 'Blueprint state file is too large.');
  }

  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(
      path,
      process.platform === 'win32' ? 'r' : fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
  } catch (error) {
    if (isMissing(error)) return null;
    throw new BlueprintCheckpointStoreError(codes.unsafe, 'Blueprint state file is unsafe.', {
      cause: error,
    });
  }
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || !sameFileIdentity(metadata, opened) || opened.size > maxBytes) {
      throw new BlueprintCheckpointStoreError(codes.unsafe, 'Blueprint state file is unsafe.');
    }
    const bytes = await readHandleBounded(handle, maxBytes);
    if (bytes === null) {
      throw new BlueprintCheckpointStoreError(
        codes.malformed,
        'Blueprint state file is too large.',
      );
    }
    return { bytes, stat: opened };
  } catch (error) {
    if (error instanceof BlueprintCheckpointStoreError) throw error;
    throw new BlueprintCheckpointStoreError(codes.io, 'Blueprint state file could not be read.', {
      cause: error,
    });
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function readHandleBounded(
  handle: Awaited<ReturnType<typeof open>>,
  maxBytes: number,
): Promise<Buffer | null> {
  const bytes = Buffer.alloc(maxBytes + 1);
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  return offset > maxBytes ? null : bytes.subarray(0, offset);
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

async function chmodVerifiedRegularFile(
  path: string,
  mode: number,
  unsafeCode: BlueprintCheckpointStoreError['code'],
): Promise<void> {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new BlueprintCheckpointStoreError(unsafeCode, 'Blueprint state file is unsafe.');
  }
  const handle = await open(
    path,
    process.platform === 'win32' ? 'r' : fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
  );
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || !sameFileIdentity(metadata, opened)) {
      throw new BlueprintCheckpointStoreError(unsafeCode, 'Blueprint state file is unsafe.');
    }
    try {
      await handle.chmod(mode);
    } catch (error) {
      if (!isUnsupportedChmod(error)) throw error;
    }
  } finally {
    await handle.close().catch(() => undefined);
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

async function readLock(path: string): Promise<{ record: LockRecord; stat: FileMetadata } | null> {
  let file: BoundedFileRead | null;
  try {
    file = await readBoundedRegularFile(path, MAX_LOCK_BYTES, {
      unsafe: 'LOCK_UNSAFE',
      nonFile: 'LOCK_UNSAFE',
      malformed: 'LOCK_MALFORMED',
      io: 'CHECKPOINT_IO',
    });
  } catch (error) {
    if (error instanceof BlueprintCheckpointStoreError && error.code === 'LOCK_MALFORMED') {
      return null;
    }
    throw error;
  }
  if (file === null) return null;
  const record = lockRecordFromText(file.bytes.toString('utf8'));
  return record === null ? null : { record, stat: file.stat };
}

export interface AuthenticatedBlueprintCheckpointOptions {
  readonly stateDirectory: string;
  readonly planId: string;
  readonly signingSecret: string;
}

interface BlueprintCheckpointStoreOptions extends AuthenticatedBlueprintCheckpointOptions {
  readonly now?: () => number;
  readonly staleLockMs?: number;
}

/**
 * Local, append-only checkpoint state for one blueprint plan.
 * The plan token is never persisted; terminal Activity Evidence retains only
 * the trusted blueprint required for later read-only verification.
 */
export class BlueprintCheckpointStore {
  readonly #stateDirectory: string;
  readonly #planId: string;
  readonly #planDirectory: string;
  readonly #lockPath: string;
  readonly #activityEvidencePath: string;
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
    this.#activityEvidencePath = join(this.#planDirectory, ACTIVITY_EVIDENCE_FILE_NAME);
    this.#signingSecret = options.signingSecret;
    this.#now = options.now ?? Date.now;
    this.#staleLockMs = options.staleLockMs ?? DEFAULT_STALE_LOCK_MS;
  }

  get planId(): string {
    return this.#planId;
  }

  async load(): Promise<BlueprintCheckpoint | null> {
    try {
      if (!(await inspectDirectory(this.#planDirectory, 'CHECKPOINT_UNSAFE'))) return null;
    } catch (error) {
      if (error instanceof BlueprintCheckpointStoreError) throw error;
      throw new BlueprintCheckpointStoreError(
        'CHECKPOINT_IO',
        'Unable to inspect checkpoint state',
        { cause: error },
      );
    }
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
    const file = await readBoundedRegularFile(path, MAX_CHECKPOINT_BYTES, {
      unsafe: 'CHECKPOINT_UNSAFE',
      nonFile: 'CHECKPOINT_MALFORMED',
      malformed: 'CHECKPOINT_MALFORMED',
      io: 'CHECKPOINT_IO',
    });
    if (file === null) {
      throw new BlueprintCheckpointStoreError(
        'CHECKPOINT_MALFORMED',
        'Highest checkpoint disappeared while reading',
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(file.bytes.toString('utf8'));
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
      await chmodVerifiedRegularFile(destination, 0o600, 'CHECKPOINT_UNSAFE');
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

  async loadEvidence(): Promise<GuildBlueprintActivityEvidence | null> {
    try {
      if (!(await inspectDirectory(this.#planDirectory, 'EVIDENCE_UNSAFE'))) return null;
    } catch (error) {
      if (error instanceof BlueprintCheckpointStoreError) throw error;
      throw new BlueprintCheckpointStoreError(
        'EVIDENCE_IO',
        'Activity Evidence directory could not be inspected.',
        { cause: error },
      );
    }
    const file = await readBoundedRegularFile(
      this.#activityEvidencePath,
      MAX_ACTIVITY_EVIDENCE_BYTES,
      {
        unsafe: 'EVIDENCE_UNSAFE',
        nonFile: 'EVIDENCE_IO',
        malformed: 'EVIDENCE_MALFORMED',
        io: 'EVIDENCE_IO',
      },
    );
    if (file === null) return null;
    let raw: unknown;
    try {
      raw = JSON.parse(file.bytes.toString('utf8'));
    } catch (error) {
      throw new BlueprintCheckpointStoreError(
        'EVIDENCE_MALFORMED',
        'Activity Evidence is not valid JSON.',
        { cause: error },
      );
    }
    const envelope = ActivityEvidenceEnvelopeSchema.safeParse(raw);
    if (!envelope.success) {
      throw new BlueprintCheckpointStoreError(
        'EVIDENCE_MALFORMED',
        'Activity Evidence failed envelope validation.',
      );
    }
    const expectedTag = activityEvidenceAuthTag(envelope.data.evidence, this.#signingSecret);
    if (!equalHex(envelope.data.auth_tag, expectedTag)) {
      throw new BlueprintCheckpointStoreError(
        'EVIDENCE_TAMPERED',
        'Activity Evidence authentication failed.',
      );
    }
    try {
      assertGuildBlueprintActivityEvidence(envelope.data.evidence);
    } catch (error) {
      throw new BlueprintCheckpointStoreError(
        'EVIDENCE_MALFORMED',
        'Activity Evidence failed digest or blueprint validation.',
        { cause: error },
      );
    }
    if (envelope.data.evidence.plan_id !== this.#planId) {
      throw new BlueprintCheckpointStoreError(
        'EVIDENCE_MALFORMED',
        'Activity Evidence belongs to a different plan.',
      );
    }
    return envelope.data.evidence;
  }

  async saveEvidence(evidence: GuildBlueprintActivityEvidence): Promise<void> {
    const parsed = GuildBlueprintActivityEvidenceSchema.safeParse(evidence);
    if (!parsed.success || parsed.data.plan_id !== this.#planId) {
      throw new BlueprintCheckpointStoreError(
        'INVALID_EVIDENCE',
        'Activity Evidence does not match this plan or schema.',
      );
    }
    try {
      assertGuildBlueprintActivityEvidence(parsed.data);
    } catch (error) {
      throw new BlueprintCheckpointStoreError(
        'INVALID_EVIDENCE',
        'Activity Evidence failed digest or blueprint validation.',
        { cause: error },
      );
    }

    try {
      await this.#ensureDirectory('EVIDENCE_UNSAFE');
    } catch (error) {
      if (error instanceof BlueprintCheckpointStoreError) throw error;
      throw new BlueprintCheckpointStoreError(
        'EVIDENCE_IO',
        'Unable to prepare the Activity Evidence directory.',
        { cause: error },
      );
    }
    const existing = await this.loadEvidence();
    if (existing !== null) {
      if (canonicalJson(existing) === canonicalJson(parsed.data)) return;
      throw new BlueprintCheckpointStoreError(
        'EVIDENCE_CONFLICT',
        'A different immutable Activity Evidence record already exists for this plan.',
      );
    }

    const filename = ACTIVITY_EVIDENCE_FILE_NAME;
    const temporary = join(
      this.#planDirectory,
      `.${filename}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`,
    );
    const payload = `${JSON.stringify({
      schema_version: 'guild_blueprint_activity_evidence_envelope.v1',
      evidence: parsed.data,
      auth_tag: activityEvidenceAuthTag(parsed.data, this.#signingSecret),
    })}\n`;
    let tempHandle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      tempHandle = await open(temporary, 'wx', 0o600);
      await tempHandle.writeFile(payload, 'utf8');
      await tempHandle.sync();
      await tempHandle.close();
      tempHandle = undefined;
      try {
        await link(temporary, this.#activityEvidencePath);
      } catch (error) {
        if (!isAlreadyExists(error) && !isLinkUnsupported(error)) throw error;
        if (isAlreadyExists(error)) {
          const concurrent = await this.loadEvidence();
          if (concurrent !== null && canonicalJson(concurrent) === canonicalJson(parsed.data))
            return;
          throw new BlueprintCheckpointStoreError(
            'EVIDENCE_CONFLICT',
            'A different immutable Activity Evidence record already exists for this plan.',
            { cause: error },
          );
        }
        try {
          await copyFile(temporary, this.#activityEvidencePath, fsConstants.COPYFILE_EXCL);
        } catch (copyError) {
          if (!isAlreadyExists(copyError)) throw copyError;
          const concurrent = await this.loadEvidence();
          if (concurrent !== null && canonicalJson(concurrent) === canonicalJson(parsed.data))
            return;
          throw new BlueprintCheckpointStoreError(
            'EVIDENCE_CONFLICT',
            'A different immutable Activity Evidence record already exists for this plan.',
            { cause: copyError },
          );
        }
      }
      await chmodVerifiedRegularFile(this.#activityEvidencePath, 0o600, 'EVIDENCE_UNSAFE');
      await fsyncDirectory(this.#planDirectory);
    } catch (error) {
      if (error instanceof BlueprintCheckpointStoreError) throw error;
      throw new BlueprintCheckpointStoreError('EVIDENCE_IO', 'Unable to write Activity Evidence.', {
        cause: error,
      });
    } finally {
      if (tempHandle !== undefined) await tempHandle.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
    }
  }

  async tryAcquireLock(): Promise<BlueprintCheckpointLockResult> {
    await this.#ensureDirectory('LOCK_UNSAFE');
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
      !sameFileIdentity(confirmed.stat, existing.stat) ||
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
      return this.#lease(record);
    } catch (error) {
      if (isAlreadyExists(error)) return { acquired: false, reason: 'busy' };
      throw error;
    }
  }

  async #ensureDirectory(
    unsafeCode: BlueprintCheckpointStoreError['code'] = 'CHECKPOINT_UNSAFE',
  ): Promise<void> {
    await mkdir(this.#stateDirectory, { recursive: true, mode: 0o700 });
    if (!(await inspectDirectory(this.#stateDirectory, unsafeCode))) {
      throw new BlueprintCheckpointStoreError(unsafeCode, 'State directory is unsafe.');
    }
    await chmodSecure(this.#stateDirectory, 0o700);
    await mkdir(this.#planDirectory, { recursive: true, mode: 0o700 });
    if (!(await inspectDirectory(this.#planDirectory, unsafeCode))) {
      throw new BlueprintCheckpointStoreError(unsafeCode, 'Plan directory is unsafe.');
    }
    await chmodSecure(this.#planDirectory, 0o700);
  }

  #isStale(record: LockRecord, lockStat: FileMetadata): boolean {
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
        const before = await readLock(this.#lockPath);
        if (
          before === null ||
          before.record.nonce !== record.nonce ||
          before.record.plan_id !== this.#planId
        ) {
          return false;
        }
        let handle: Awaited<ReturnType<typeof open>>;
        try {
          handle = await open(
            this.#lockPath,
            process.platform === 'win32' ? 'r+' : fsConstants.O_RDWR | fsConstants.O_NOFOLLOW,
          );
        } catch (error) {
          if (isMissing(error)) return false;
          throw error;
        }
        try {
          const ownedStat = await handle.stat();
          if (
            !ownedStat.isFile() ||
            ownedStat.size > MAX_LOCK_BYTES ||
            !sameFileIdentity(before.stat, ownedStat)
          )
            return false;
          const lockBytes = await readHandleBounded(handle, MAX_LOCK_BYTES);
          if (lockBytes === null) return false;
          const currentRecord = lockRecordFromText(lockBytes.toString('utf8'));
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
            sameFileIdentity(current.stat, ownedStat)
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
        let latest: FileMetadata;
        try {
          latest = await lstat(this.#lockPath);
        } catch (error) {
          if (isMissing(error)) return;
          throw error;
        }
        if (latest.isSymbolicLink() || !sameFileIdentity(current.stat, latest)) return;
        await unlink(this.#lockPath).catch((error) => {
          if (!isMissing(error)) throw error;
        });
      },
    };
  }
}

export async function loadAuthenticatedBlueprintCheckpoint(
  options: AuthenticatedBlueprintCheckpointOptions,
): Promise<BlueprintCheckpoint | null> {
  return new BlueprintCheckpointStore(options).load();
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
    await lstat(path);
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  throw new BlueprintCheckpointStoreError(
    'CHECKPOINT_VERSION_CONFLICT',
    'Checkpoint destination already exists',
  );
}
