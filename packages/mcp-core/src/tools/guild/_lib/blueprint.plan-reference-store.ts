import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { chmod, link, lstat, mkdir, open, opendir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import {
  type GuildBlueprintPlanPayload,
  GuildBlueprintPlanPayloadSchema,
} from './blueprint.execution.schema.js';
import { encodeBlueprintPlan } from './blueprint.plan-token.js';
import { canonicalJson } from './blueprint.validation.js';

const REFERENCE_DIRECTORY_NAME = 'plan-references-v1';
const REFERENCE_PREFIX = 'dmbpr1';
const REFERENCE_PATTERN = /^dmbpr1\.([a-f0-9]{64})$/;
const REFERENCE_FILE_PATTERN = /^[a-f0-9]{64}\.json$/;
const QUOTA_LOCK_FILE_NAME = 'quota.lock';
const MAX_ENVELOPE_BYTES = 1_048_576;
const MAX_REFERENCE_RECORDS = 256;
const MAX_REFERENCE_TOTAL_BYTES = 64 * 1024 * 1024;
const QUOTA_LOCK_RETRY_MS = 10;
const QUOTA_LOCK_TIMEOUT_MS = 5_000;
const QUOTA_LOCK_STALE_MS = 30_000;
const MAX_QUOTA_LOCK_BYTES = 4_096;

const BlueprintPlanReferenceEnvelopeSchema = z
  .object({
    schema_version: z.literal('guild_blueprint_plan_reference_envelope.v1'),
    reference: z.string().regex(REFERENCE_PATTERN),
    plan_id: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    payload: GuildBlueprintPlanPayloadSchema,
    auth_tag: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

type BlueprintPlanReferenceEnvelope = z.infer<typeof BlueprintPlanReferenceEnvelopeSchema>;

const QuotaLockRecordSchema = z
  .object({
    schema_version: z.literal('guild_blueprint_plan_reference_quota_lock.v1'),
    nonce: z.string().regex(/^[a-f0-9]{32}$/),
    created_at_ms: z.number().int().nonnegative(),
    pid: z.number().int().positive(),
  })
  .strict();

type QuotaLockRecord = z.infer<typeof QuotaLockRecordSchema>;

export interface BlueprintPlanReferenceStoreOptions {
  readonly stateDirectory: string;
  readonly signingSecret: string;
}

export interface SaveBlueprintPlanReferenceOptions extends BlueprintPlanReferenceStoreOptions {
  readonly planId: string;
  readonly payload: GuildBlueprintPlanPayload;
}

export interface LoadBlueprintPlanReferenceOptions extends BlueprintPlanReferenceStoreOptions {
  readonly planRef: string;
}

export class BlueprintPlanReferenceStoreError extends Error {
  public override readonly name = 'BlueprintPlanReferenceStoreError';

  public constructor(
    public readonly code:
      | 'INVALID_REFERENCE'
      | 'INVALID_PAYLOAD'
      | 'PLAN_REFERENCE_NOT_FOUND'
      | 'PLAN_REFERENCE_MALFORMED'
      | 'PLAN_REFERENCE_TAMPERED'
      | 'PLAN_REFERENCE_CONFLICT'
      | 'PLAN_REFERENCE_QUOTA'
      | 'PLAN_REFERENCE_UNSAFE'
      | 'PLAN_REFERENCE_IO',
    message: string,
  ) {
    super(message);
  }
}

function referenceForPlanId(planId: string, signingSecret: string): string {
  const digest = createHmac('sha256', signingSecret)
    .update(`discord-mcp-blueprint-plan-reference.v1\0${planId}`)
    .digest('hex');
  return `${REFERENCE_PREFIX}.${digest}`;
}

function envelopeAuthTag(
  envelope: Omit<BlueprintPlanReferenceEnvelope, 'auth_tag'>,
  signingSecret: string,
): string {
  return createHmac('sha256', signingSecret)
    .update(`discord-mcp-blueprint-plan-reference-envelope.v1\0${canonicalJson(envelope)}`)
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

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST';
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
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
  return (
    process.platform === 'win32' ||
    (error instanceof Error &&
      'code' in error &&
      ['EINVAL', 'ENOTSUP'].includes(String(error.code)))
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

function assertReference(reference: string): void {
  if (typeof reference !== 'string' || !REFERENCE_PATTERN.test(reference)) {
    throw new BlueprintPlanReferenceStoreError('INVALID_REFERENCE', 'Plan reference is invalid.');
  }
}

function assertOptions(options: BlueprintPlanReferenceStoreOptions): void {
  if (
    typeof options.stateDirectory !== 'string' ||
    options.stateDirectory.trim().length === 0 ||
    typeof options.signingSecret !== 'string' ||
    options.signingSecret.length === 0
  ) {
    throw new BlueprintPlanReferenceStoreError(
      'PLAN_REFERENCE_IO',
      'Plan reference storage is unavailable.',
    );
  }
}

async function assertDirectory(path: string): Promise<void> {
  let metadata: Awaited<ReturnType<typeof lstat>>;
  try {
    metadata = await lstat(path);
  } catch {
    throw new BlueprintPlanReferenceStoreError(
      'PLAN_REFERENCE_IO',
      'Plan reference storage is unavailable.',
    );
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new BlueprintPlanReferenceStoreError(
      'PLAN_REFERENCE_UNSAFE',
      'Plan reference storage is unsafe.',
    );
  }
}

async function ensureDirectory(options: BlueprintPlanReferenceStoreOptions): Promise<string> {
  try {
    await mkdir(options.stateDirectory, { recursive: true, mode: 0o700 });
    await assertDirectory(options.stateDirectory);
    await chmodSecure(options.stateDirectory, 0o700);
    const directory = join(options.stateDirectory, REFERENCE_DIRECTORY_NAME);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await assertDirectory(directory);
    await chmodSecure(directory, 0o700);
    return directory;
  } catch (error) {
    if (error instanceof BlueprintPlanReferenceStoreError) throw error;
    throw new BlueprintPlanReferenceStoreError(
      'PLAN_REFERENCE_IO',
      'Plan reference storage is unavailable.',
    );
  }
}

function referencePath(directory: string, reference: string): string {
  assertReference(reference);
  return join(directory, `${reference.slice(`${REFERENCE_PREFIX}.`.length)}.json`);
}

async function readBoundedRegularFile(path: string): Promise<Buffer | null> {
  let metadata: Awaited<ReturnType<typeof lstat>>;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if (isMissing(error)) return null;
    throw new BlueprintPlanReferenceStoreError(
      'PLAN_REFERENCE_IO',
      'Plan reference storage is unavailable.',
    );
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new BlueprintPlanReferenceStoreError(
      'PLAN_REFERENCE_UNSAFE',
      'Plan reference storage is unsafe.',
    );
  }
  if (metadata.size > MAX_ENVELOPE_BYTES) {
    throw new BlueprintPlanReferenceStoreError(
      'PLAN_REFERENCE_MALFORMED',
      'Plan reference record is malformed.',
    );
  }

  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(
      path,
      process.platform === 'win32' ? 'r' : fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
  } catch (error) {
    if (isMissing(error)) return null;
    throw new BlueprintPlanReferenceStoreError(
      'PLAN_REFERENCE_UNSAFE',
      'Plan reference storage is unsafe.',
    );
  }
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > MAX_ENVELOPE_BYTES) {
      throw new BlueprintPlanReferenceStoreError(
        'PLAN_REFERENCE_MALFORMED',
        'Plan reference record is malformed.',
      );
    }
    const bytes = Buffer.alloc(MAX_ENVELOPE_BYTES + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > MAX_ENVELOPE_BYTES) {
      throw new BlueprintPlanReferenceStoreError(
        'PLAN_REFERENCE_MALFORMED',
        'Plan reference record is malformed.',
      );
    }
    return bytes.subarray(0, offset);
  } catch (error) {
    if (error instanceof BlueprintPlanReferenceStoreError) throw error;
    throw new BlueprintPlanReferenceStoreError(
      'PLAN_REFERENCE_IO',
      'Plan reference storage is unavailable.',
    );
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function parseEnvelope(bytes: Buffer, signingSecret: string): BlueprintPlanReferenceEnvelope {
  let text: string;
  let raw: unknown;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    raw = JSON.parse(text);
  } catch {
    throw new BlueprintPlanReferenceStoreError(
      'PLAN_REFERENCE_MALFORMED',
      'Plan reference record is malformed.',
    );
  }
  const parsed = BlueprintPlanReferenceEnvelopeSchema.safeParse(raw);
  if (!parsed.success) {
    throw new BlueprintPlanReferenceStoreError(
      'PLAN_REFERENCE_MALFORMED',
      'Plan reference record is malformed.',
    );
  }
  const { auth_tag: authTag, ...unsigned } = parsed.data;
  if (!equalHex(authTag, envelopeAuthTag(unsigned, signingSecret))) {
    throw new BlueprintPlanReferenceStoreError(
      'PLAN_REFERENCE_TAMPERED',
      'Plan reference authentication failed.',
    );
  }
  return parsed.data;
}

function decodedPlan(
  envelope: BlueprintPlanReferenceEnvelope,
  signingSecret: string,
): ReturnType<typeof encodeBlueprintPlan> {
  let encoded: ReturnType<typeof encodeBlueprintPlan>;
  try {
    encoded = encodeBlueprintPlan(envelope.payload, signingSecret);
  } catch {
    throw new BlueprintPlanReferenceStoreError(
      'PLAN_REFERENCE_MALFORMED',
      'Plan reference record is malformed.',
    );
  }
  if (
    encoded.plan_id !== envelope.plan_id ||
    referenceForPlanId(encoded.plan_id, signingSecret) !== envelope.reference
  ) {
    throw new BlueprintPlanReferenceStoreError(
      'PLAN_REFERENCE_MALFORMED',
      'Plan reference record is malformed.',
    );
  }
  return encoded;
}

async function readEnvelope(
  directory: string,
  reference: string,
  signingSecret: string,
): Promise<BlueprintPlanReferenceEnvelope | null> {
  const bytes = await readBoundedRegularFile(referencePath(directory, reference));
  return bytes === null ? null : parseEnvelope(bytes, signingSecret);
}

async function assertReferenceQuota(directory: string, incomingBytes: number): Promise<void> {
  let records = 0;
  let totalBytes = 0;
  try {
    const entries = await opendir(directory);
    for await (const entry of entries) {
      if (!REFERENCE_FILE_PATTERN.test(entry.name)) continue;
      const metadata = await lstat(join(directory, entry.name));
      if (metadata.isSymbolicLink() || !metadata.isFile()) {
        throw new BlueprintPlanReferenceStoreError(
          'PLAN_REFERENCE_UNSAFE',
          'Plan reference storage is unsafe.',
        );
      }
      records += 1;
      totalBytes += metadata.size;
      if (
        records + 1 > MAX_REFERENCE_RECORDS ||
        totalBytes + incomingBytes > MAX_REFERENCE_TOTAL_BYTES
      ) {
        throw new BlueprintPlanReferenceStoreError(
          'PLAN_REFERENCE_QUOTA',
          'Plan reference storage reached its bounded capacity.',
        );
      }
    }
  } catch (error) {
    if (error instanceof BlueprintPlanReferenceStoreError) throw error;
    throw new BlueprintPlanReferenceStoreError(
      'PLAN_REFERENCE_IO',
      'Plan reference storage is unavailable.',
    );
  }
}

async function readQuotaLock(path: string): Promise<{
  record: QuotaLockRecord;
  metadata: Awaited<ReturnType<typeof lstat>>;
} | null> {
  let metadata: Awaited<ReturnType<typeof lstat>>;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size > MAX_QUOTA_LOCK_BYTES) {
    throw new BlueprintPlanReferenceStoreError(
      'PLAN_REFERENCE_UNSAFE',
      'Plan reference storage is unsafe.',
    );
  }

  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(
      path,
      process.platform === 'win32' ? 'r' : fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > MAX_QUOTA_LOCK_BYTES) {
      throw new BlueprintPlanReferenceStoreError(
        'PLAN_REFERENCE_UNSAFE',
        'Plan reference storage is unsafe.',
      );
    }
    const parsed = QuotaLockRecordSchema.safeParse(JSON.parse(await handle.readFile('utf8')));
    return parsed.success ? { record: parsed.data, metadata: opened } : null;
  } catch (error) {
    if (error instanceof BlueprintPlanReferenceStoreError) throw error;
    return null;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function isStaleQuotaLock(
  lock: NonNullable<Awaited<ReturnType<typeof readQuotaLock>>>,
  now = Date.now(),
): boolean {
  const modifiedAt = Number(lock.metadata.mtimeMs);
  return (
    !isProcessAlive(lock.record.pid) &&
    now >= lock.record.created_at_ms &&
    now - lock.record.created_at_ms >= QUOTA_LOCK_STALE_MS &&
    now >= modifiedAt &&
    now - modifiedAt >= QUOTA_LOCK_STALE_MS
  );
}

async function withQuotaLock<T>(directory: string, operation: () => Promise<T>): Promise<T> {
  const lockPath = join(directory, QUOTA_LOCK_FILE_NAME);
  const deadline = Date.now() + QUOTA_LOCK_TIMEOUT_MS;
  const record: QuotaLockRecord = {
    schema_version: 'guild_blueprint_plan_reference_quota_lock.v1',
    nonce: randomBytes(16).toString('hex'),
    created_at_ms: Date.now(),
    pid: process.pid,
  };
  for (;;) {
    try {
      const handle = await open(lockPath, 'wx', 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await chmodSecure(lockPath, 0o600);
      break;
    } catch (error) {
      if (!isAlreadyExists(error)) {
        throw new BlueprintPlanReferenceStoreError(
          'PLAN_REFERENCE_IO',
          'Plan reference storage is unavailable.',
        );
      }
      try {
        const existing = await readQuotaLock(lockPath);
        if (existing !== null && isStaleQuotaLock(existing)) {
          // Match the checkpoint-store lock discipline: a malformed, live, or
          // replaced record is never reclaimed. The second read narrows the
          // stale-owner race before the exclusive-create retry below.
          const confirmed = await readQuotaLock(lockPath);
          if (
            confirmed !== null &&
            confirmed.record.nonce === existing.record.nonce &&
            confirmed.metadata.ino === existing.metadata.ino &&
            confirmed.metadata.mtimeMs === existing.metadata.mtimeMs &&
            isStaleQuotaLock(confirmed)
          ) {
            await unlink(lockPath).catch((unlinkError) => {
              if (!isMissing(unlinkError)) throw unlinkError;
            });
            continue;
          }
        }
      } catch (metadataError) {
        if (!isMissing(metadataError) && !(metadataError instanceof SyntaxError)) {
          throw new BlueprintPlanReferenceStoreError(
            'PLAN_REFERENCE_IO',
            'Plan reference storage is unavailable.',
          );
        }
      }
      if (Date.now() >= deadline) {
        throw new BlueprintPlanReferenceStoreError(
          'PLAN_REFERENCE_IO',
          'Plan reference storage is unavailable.',
        );
      }
      await wait(QUOTA_LOCK_RETRY_MS);
    }
  }
  try {
    return await operation();
  } finally {
    const current = await readQuotaLock(lockPath).catch(() => null);
    if (current?.record.nonce === record.nonce) {
      await unlink(lockPath).catch(() => undefined);
    }
  }
}

/**
 * Save a plan payload under its deterministic, profile-secret authenticated local reference.
 * The caller-carried plan token is deliberately never accepted or persisted here.
 */
export async function saveBlueprintPlanReference(
  options: SaveBlueprintPlanReferenceOptions,
): Promise<string> {
  assertOptions(options);
  const payload = GuildBlueprintPlanPayloadSchema.safeParse(options.payload);
  if (!payload.success) {
    throw new BlueprintPlanReferenceStoreError(
      'INVALID_PAYLOAD',
      'Blueprint plan payload is invalid.',
    );
  }
  let encoded: ReturnType<typeof encodeBlueprintPlan>;
  try {
    encoded = encodeBlueprintPlan(payload.data, options.signingSecret);
  } catch {
    throw new BlueprintPlanReferenceStoreError(
      'INVALID_PAYLOAD',
      'Blueprint plan payload is invalid.',
    );
  }
  if (options.planId !== encoded.plan_id) {
    throw new BlueprintPlanReferenceStoreError(
      'INVALID_PAYLOAD',
      'Blueprint plan payload is invalid.',
    );
  }
  const reference = referenceForPlanId(encoded.plan_id, options.signingSecret);
  const unsigned = {
    schema_version: 'guild_blueprint_plan_reference_envelope.v1' as const,
    reference,
    plan_id: encoded.plan_id,
    payload: payload.data,
  };
  const envelope: BlueprintPlanReferenceEnvelope = {
    ...unsigned,
    auth_tag: envelopeAuthTag(unsigned, options.signingSecret),
  };
  const serializedEnvelope = `${JSON.stringify(envelope)}\n`;
  if (Buffer.byteLength(serializedEnvelope, 'utf8') > MAX_ENVELOPE_BYTES) {
    throw new BlueprintPlanReferenceStoreError(
      'INVALID_PAYLOAD',
      'Blueprint plan payload is invalid.',
    );
  }
  const directory = await ensureDirectory(options);
  const destination = referencePath(directory, reference);
  const existing = await readEnvelope(directory, reference, options.signingSecret);
  if (existing !== null) {
    if (
      existing.reference === envelope.reference &&
      existing.plan_id === envelope.plan_id &&
      canonicalJson(existing.payload) === canonicalJson(envelope.payload)
    ) {
      decodedPlan(existing, options.signingSecret);
      return reference;
    }
    throw new BlueprintPlanReferenceStoreError(
      'PLAN_REFERENCE_CONFLICT',
      'Plan reference is already reserved.',
    );
  }
  return withQuotaLock(directory, async () => {
    const concurrent = await readEnvelope(directory, reference, options.signingSecret);
    if (concurrent !== null) {
      if (
        concurrent.reference === envelope.reference &&
        concurrent.plan_id === envelope.plan_id &&
        canonicalJson(concurrent.payload) === canonicalJson(envelope.payload)
      ) {
        decodedPlan(concurrent, options.signingSecret);
        return reference;
      }
      throw new BlueprintPlanReferenceStoreError(
        'PLAN_REFERENCE_CONFLICT',
        'Plan reference is already reserved.',
      );
    }
    await assertReferenceQuota(directory, Buffer.byteLength(serializedEnvelope, 'utf8'));

    const temporary = join(
      directory,
      `.${reference.slice(`${REFERENCE_PREFIX}.`.length)}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`,
    );
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temporary, 'wx', 0o600);
      await handle.writeFile(serializedEnvelope, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await chmodSecure(temporary, 0o600);
      // Hard-link publication is the only supported no-clobber commit path.
      // If the filesystem cannot provide it, fail closed so the planner can
      // return its self-contained legacy token instead of risking a partial
      // deterministic destination after interruption.
      await link(temporary, destination);
      await chmodSecure(destination, 0o600);
      await fsyncDirectory(directory);
    } catch (error) {
      if (error instanceof BlueprintPlanReferenceStoreError) throw error;
      throw new BlueprintPlanReferenceStoreError(
        'PLAN_REFERENCE_IO',
        'Plan reference storage is unavailable.',
      );
    } finally {
      if (handle !== undefined) await handle.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
    }
    return reference;
  });
}

/** Load and verify the payload behind a caller-supplied local plan reference. */
export async function loadBlueprintPlanReference(
  options: LoadBlueprintPlanReferenceOptions,
): Promise<{ payload: GuildBlueprintPlanPayload; plan_id: string; approval_id: string }> {
  assertOptions(options);
  assertReference(options.planRef);
  const directory = await ensureDirectory(options);
  const envelope = await readEnvelope(directory, options.planRef, options.signingSecret);
  if (envelope === null) {
    throw new BlueprintPlanReferenceStoreError(
      'PLAN_REFERENCE_NOT_FOUND',
      'Plan reference was not found.',
    );
  }
  const encoded = decodedPlan(envelope, options.signingSecret);
  if (envelope.reference !== options.planRef) {
    throw new BlueprintPlanReferenceStoreError(
      'PLAN_REFERENCE_MALFORMED',
      'Plan reference record is malformed.',
    );
  }
  return {
    payload: envelope.payload,
    plan_id: encoded.plan_id,
    approval_id: encoded.approval_id,
  };
}
