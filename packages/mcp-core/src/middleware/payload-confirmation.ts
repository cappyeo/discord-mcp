import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { redactArgs } from '../audit/redact.js';
import {
  PayloadConfirmationApprovalExpired,
  PayloadConfirmationApprovalMismatch,
  PayloadConfirmationApprovalMissing,
  PayloadConfirmationApprovalReplayed,
  PayloadConfirmationMismatch,
  PayloadConfirmationRequired,
  ValidationError,
} from '../errors/client.js';
import { fingerprintPayload } from '../tools/_lib/payload-fingerprint.js';
import { interpolateTemplate } from '../tools/components-v2/_lib/interpolate.js';
import { ComponentTypeId } from '../tools/components-v2/_lib/schema.js';
import { validateComponentsV2 } from '../tools/components-v2/_lib/validator.js';
import { TEMPLATES } from '../tools/components-v2/templates/index.js';
import type { MiddlewareContext, ToolMiddleware } from './compose.js';

const PAYLOAD_CONFIRMATION_KIND = 'payload_hash' as const;
const PAYLOAD_CONFIRMATION_TOOL_NAMES = new Set([
  'components_v2_send',
  'components_v2_edit',
  'components_v2_send_from_template',
]);
const HASH_RE = /^[a-f0-9]{64}$/u;
const INTERACTIVE_TYPES = new Set<number>([
  ComponentTypeId.Button,
  ComponentTypeId.StringSelect,
  ComponentTypeId.TextInput,
  ComponentTypeId.UserSelect,
  ComponentTypeId.RoleSelect,
  ComponentTypeId.MentionableSelect,
  ComponentTypeId.ChannelSelect,
]);
const URL_RE = /https?:\/\/[^\s"'<>]+/iu;

export interface ComponentsV2RiskAssessment {
  readonly componentCount: number;
  readonly riskFlags: readonly string[];
}

export interface ComponentsV2Review {
  readonly totalNodes: number;
  readonly typeCounts: Readonly<Record<string, number>>;
  readonly textNodes: number;
  readonly maxTextLength: number;
  readonly externalUrlHosts: readonly string[];
  readonly interactiveCount: number;
  readonly customIdLengths: readonly number[];
  readonly customIdHashes: readonly string[];
}

export interface PayloadConfirmationOptions {
  /** Environment source is injectable so the policy is deterministic in tests. */
  readonly env?: Record<string, string | undefined>;
  /** Process-local ledger. A different HTTP replica fails closed on unknown approvals. */
  readonly ledger?: PayloadApprovalLedgerLike;
  /** Optional caller-owned bot identity to bind into the approval record. */
  readonly botId?: string;
  readonly approvalTtlMs?: number;
}

export interface PayloadApprovalBinding {
  readonly tool: string;
  readonly payloadHash: string;
  readonly target: string;
  readonly botId?: string;
}

export interface PayloadApprovalLedgerLike {
  issue(binding: PayloadApprovalBinding): { approvalId: string; expiresAt: number };
  consume(
    approvalId: string,
    binding: PayloadApprovalBinding,
  ): 'ok' | 'missing' | 'expired' | 'replayed' | 'mismatch';
}

interface PayloadApprovalRecord extends PayloadApprovalBinding {
  readonly expiresAt: number;
}

interface PayloadApprovalTerminalRecord {
  readonly state: 'consumed' | 'expired';
  readonly expiresAt: number;
}

const DEFAULT_APPROVAL_TTL_MS = 5 * 60_000;
/** Total pending + terminal records retained per process. */
const MAX_APPROVAL_RECORDS = 1_024;
const MIN_APPROVAL_TTL_MS = 1;
const MAX_APPROVAL_TTL_MS = 15 * 60_000;

export class PayloadApprovalLedger implements PayloadApprovalLedgerLike {
  private readonly pending = new Map<string, PayloadApprovalRecord>();
  private readonly terminal = new Map<string, PayloadApprovalTerminalRecord>();

  public constructor(
    private readonly now: () => number = Date.now,
    ttlMs = DEFAULT_APPROVAL_TTL_MS,
  ) {
    this.ttlMs =
      Number.isFinite(ttlMs) && ttlMs >= MIN_APPROVAL_TTL_MS
        ? Math.min(ttlMs, MAX_APPROVAL_TTL_MS)
        : DEFAULT_APPROVAL_TTL_MS;
  }

  private readonly ttlMs: number;

  public issue(binding: PayloadApprovalBinding): { approvalId: string; expiresAt: number } {
    this.cleanup();
    this.boundCapacity();
    const approvalId = randomUUID();
    const expiresAt = this.now() + this.ttlMs;
    this.pending.set(approvalId, { ...binding, expiresAt });
    return { approvalId, expiresAt };
  }

  public consume(
    approvalId: string,
    binding: PayloadApprovalBinding,
  ): 'ok' | 'missing' | 'expired' | 'replayed' | 'mismatch' {
    const now = this.now();
    const terminal = this.terminal.get(approvalId);
    if (terminal !== undefined) {
      if (terminal.expiresAt > now) {
        return terminal.state === 'expired' ? 'expired' : 'replayed';
      }
      this.terminal.delete(approvalId);
    }
    const record = this.pending.get(approvalId);
    if (record === undefined) return 'missing';
    if (record.expiresAt <= now) {
      this.pending.delete(approvalId);
      this.boundCapacity();
      this.terminal.set(approvalId, { state: 'expired', expiresAt: now + this.ttlMs });
      return 'expired';
    }
    if (
      record.tool !== binding.tool ||
      record.payloadHash !== binding.payloadHash ||
      record.target !== binding.target ||
      record.botId !== binding.botId
    ) {
      return 'mismatch';
    }
    this.pending.delete(approvalId);
    this.boundCapacity();
    this.terminal.set(approvalId, { state: 'consumed', expiresAt: now + this.ttlMs });
    this.cleanup(now);
    return 'ok';
  }

  /** Number of live records, exposed for bounded-store diagnostics/tests only. */
  public get size(): number {
    this.cleanup();
    return this.pending.size + this.terminal.size;
  }

  private cleanup(now = this.now()): void {
    for (const [id, record] of this.pending) if (record.expiresAt <= now) this.pending.delete(id);
    for (const [id, record] of this.terminal) {
      if (record.expiresAt <= now) this.terminal.delete(id);
    }
  }

  private boundCapacity(): void {
    while (this.pending.size + this.terminal.size >= MAX_APPROVAL_RECORDS) {
      // Evict pending records first: an evicted approval fails closed as
      // `missing`, while retaining a terminal record is useful for replay
      // diagnostics. Both maps are insertion ordered, so this is deterministic.
      const oldestPending = this.pending.keys().next().value;
      if (oldestPending !== undefined) {
        this.pending.delete(oldestPending);
        continue;
      }
      const oldestTerminal = this.terminal.keys().next().value;
      if (oldestTerminal === undefined) return;
      this.terminal.delete(oldestTerminal);
    }
  }
}

/**
 * Optional cross-process approval ledger backed by one bounded JSON file.
 *
 * Only a SHA-256 identifier digest is persisted; the caller-visible UUID is
 * never written to disk. The HMAC covers the complete state, and every state
 * transition is serialized behind an exclusive lock and atomically replaced.
 * If the directory, lock, or state is unavailable/corrupt, operations throw
 * so the caller fails closed instead of treating an approval as valid.
 */
export class FilePayloadApprovalLedger implements PayloadApprovalLedgerLike {
  private readonly directory: string;
  private readonly statePath: string;
  private readonly lockPath: string;
  private readonly secret: Buffer;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly maxRecords: number;

  public constructor(options: {
    directory: string;
    secret: string | Buffer;
    now?: () => number;
    ttlMs?: number;
    maxRecords?: number;
  }) {
    if (typeof options.directory !== 'string' || options.directory.trim() === '') {
      throw new Error('Approval ledger directory is required');
    }
    const secret = Buffer.isBuffer(options.secret)
      ? Buffer.from(options.secret)
      : Buffer.from(options.secret, 'utf8');
    if (secret.byteLength < 32)
      throw new Error('Approval ledger HMAC secret must be at least 32 bytes');
    this.directory = resolvePath(options.directory);
    this.statePath = resolvePath(this.directory, 'approvals.json');
    this.lockPath = resolvePath(this.directory, 'approvals.lock');
    this.secret = secret;
    this.now = options.now ?? Date.now;
    const ttlMs = options.ttlMs ?? DEFAULT_APPROVAL_TTL_MS;
    this.ttlMs =
      Number.isFinite(ttlMs) && ttlMs >= MIN_APPROVAL_TTL_MS
        ? Math.min(ttlMs, MAX_APPROVAL_TTL_MS)
        : DEFAULT_APPROVAL_TTL_MS;
    const maxRecords = options.maxRecords ?? MAX_APPROVAL_RECORDS;
    this.maxRecords =
      Number.isInteger(maxRecords) && maxRecords >= 1
        ? Math.min(maxRecords, MAX_APPROVAL_RECORDS)
        : MAX_APPROVAL_RECORDS;
    try {
      mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      if (!existsSync(this.directory)) throw new Error('directory is unavailable');
    } catch (error) {
      throw new Error('Approval ledger store is unavailable', { cause: error });
    }
  }

  public issue(binding: PayloadApprovalBinding): { approvalId: string; expiresAt: number } {
    return this.withLock(() => {
      const now = this.now();
      const state = this.readState();
      const records = this.cleanup(state.records, now);
      while (records.length >= this.maxRecords) records.shift();
      const approvalId = randomUUID();
      const expiresAt = now + this.ttlMs;
      records.push({
        id: digestApprovalId(approvalId),
        state: 'pending',
        binding,
        expiresAt,
      });
      this.writeState(records);
      return { approvalId, expiresAt };
    });
  }

  public consume(
    approvalId: string,
    binding: PayloadApprovalBinding,
  ): 'ok' | 'missing' | 'expired' | 'replayed' | 'mismatch' {
    return this.withLock(() => {
      const now = this.now();
      const state = this.readState();
      const records = this.cleanup(state.records, now);
      const id = digestApprovalId(approvalId);
      const record = records.find((candidate) => candidate.id === id);
      if (record === undefined) {
        this.writeState(records);
        return 'missing';
      }
      if (record.expiresAt <= now) {
        record.state = 'expired';
        record.expiresAt = now + this.ttlMs;
        this.writeState(records);
        return 'expired';
      }
      if (record.state === 'expired') {
        this.writeState(records);
        return 'expired';
      }
      if (record.state === 'consumed') {
        this.writeState(records);
        return 'replayed';
      }
      if (!sameBinding(record.binding, binding)) {
        this.writeState(records);
        return 'mismatch';
      }
      record.state = 'consumed';
      record.expiresAt = now + this.ttlMs;
      this.writeState(records);
      return 'ok';
    });
  }

  private withLock<T>(operation: () => T): T {
    let fd: number | undefined;
    let acquired = false;
    try {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        try {
          fd = openSync(this.lockPath, 'wx', 0o600);
          acquired = true;
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          // Synchronous calls cannot yield to a promise; a short bounded wait
          // lets another process finish its atomic transition.
          const wait = new Int32Array(new SharedArrayBuffer(4));
          Atomics.wait(wait, 0, 0, 5);
        }
      }
      if (fd === undefined) throw new Error('Approval ledger lock is unavailable');
      return operation();
    } catch (error) {
      throw new Error('Approval ledger operation failed closed', { cause: error });
    } finally {
      if (fd !== undefined) closeSync(fd);
      if (acquired) {
        try {
          unlinkSync(this.lockPath);
        } catch {
          // Best effort cleanup; a failed operation remains fail-closed.
        }
      }
    }
  }

  private readState(): { records: FileApprovalRecord[] } {
    if (!existsSync(this.statePath)) return { records: [] };
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.statePath, 'utf8'));
    } catch (error) {
      throw new Error('Approval ledger state is unreadable', { cause: error });
    }
    if (
      !isRecord(parsed) ||
      parsed.version !== 1 ||
      !Array.isArray(parsed.records) ||
      typeof parsed.mac !== 'string'
    ) {
      throw new Error('Approval ledger state is invalid');
    }
    const records = parsed.records as FileApprovalRecord[];
    const payload = canonicalRecords(records);
    const expected = createHmac('sha256', this.secret).update(payload).digest('hex');
    const actual = Buffer.from(parsed.mac, 'hex');
    const expectedBytes = Buffer.from(expected, 'hex');
    if (actual.length !== expectedBytes.length || !timingSafeEqual(actual, expectedBytes)) {
      throw new Error('Approval ledger integrity check failed');
    }
    for (const record of records) {
      if (!isValidFileRecord(record)) throw new Error('Approval ledger record is invalid');
    }
    return { records };
  }

  private writeState(records: FileApprovalRecord[]): void {
    const payload = canonicalRecords(records);
    const mac = createHmac('sha256', this.secret).update(payload).digest('hex');
    const state = `${JSON.stringify({ version: 1, records, mac })}\n`;
    const tempPath = `${this.statePath}.${process.pid}.${randomUUID()}.tmp`;
    let fd: number | undefined;
    try {
      fd = openSync(tempPath, 'wx', 0o600);
      writeFileSync(fd, state, 'utf8');
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(tempPath, this.statePath);
    } finally {
      if (fd !== undefined) closeSync(fd);
      try {
        unlinkSync(tempPath);
      } catch {
        // The rename succeeded or the temporary file was never created.
      }
    }
  }

  private cleanup(records: FileApprovalRecord[], now: number): FileApprovalRecord[] {
    // Keep an expired pending approval until its first consume so callers get
    // the stable `expired` result; terminal records then have a bounded grace
    // period (their expiresAt is advanced when consumed/expired).
    return records.filter((record) => record.state === 'pending' || record.expiresAt > now);
  }
}

interface FileApprovalRecord {
  id: string;
  state: 'pending' | 'consumed' | 'expired';
  binding: PayloadApprovalBinding;
  expiresAt: number;
}

function digestApprovalId(approvalId: string): string {
  return createHash('sha256').update(approvalId, 'utf8').digest('hex');
}

function canonicalRecords(records: readonly FileApprovalRecord[]): string {
  return JSON.stringify({ version: 1, records });
}

function sameBinding(a: PayloadApprovalBinding, b: PayloadApprovalBinding): boolean {
  return (
    a.tool === b.tool &&
    a.payloadHash === b.payloadHash &&
    a.target === b.target &&
    a.botId === b.botId
  );
}

function isValidFileRecord(value: unknown): value is FileApprovalRecord {
  if (!isRecord(value) || typeof value.id !== 'string' || !/^[a-f0-9]{64}$/u.test(value.id))
    return false;
  if (
    !['pending', 'consumed', 'expired'].includes(String(value.state)) ||
    typeof value.expiresAt !== 'number'
  )
    return false;
  if (
    !isRecord(value.binding) ||
    typeof value.binding.tool !== 'string' ||
    typeof value.binding.payloadHash !== 'string' ||
    typeof value.binding.target !== 'string'
  )
    return false;
  return value.binding.botId === undefined || typeof value.binding.botId === 'string';
}

function canonicalTarget(args: Record<string, unknown>, toolName: string): string {
  return JSON.stringify({
    channel_id: args.channel_id ?? null,
    ...(toolName === 'components_v2_edit' ? { message_id: args.message_id ?? null } : {}),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function inspectValue(value: unknown, state: { externalUrl: boolean; interactive: boolean }): void {
  if (typeof value === 'string') {
    if (URL_RE.test(value)) state.externalUrl = true;
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) inspectValue(item, state);
    return;
  }
  if (!isRecord(value)) return;
  if (typeof value.type === 'number' && INTERACTIVE_TYPES.has(value.type)) {
    state.interactive = true;
  }
  if (typeof value.custom_id === 'string') state.interactive = true;
  for (const child of Object.values(value)) inspectValue(child, state);
}

function componentTypeName(type: number): string {
  const entry = Object.entries(ComponentTypeId).find(([, value]) => value === type);
  return entry?.[0] ?? `unknown_${type}`;
}

/**
 * Produce a bounded, non-content preview of a component tree. Text and
 * identifiers are represented by lengths/digests so untrusted Discord-facing
 * strings do not become trusted instructions in an approval response.
 */
export function reviewComponentsV2(components: readonly unknown[]): ComponentsV2Review {
  const typeCounts: Record<string, number> = {};
  const externalUrlHosts = new Set<string>();
  const customIdLengths: number[] = [];
  const customIdHashes: string[] = [];
  let totalNodes = 0;
  let textNodes = 0;
  let maxTextLength = 0;
  let interactiveCount = 0;
  const visit = (value: unknown): void => {
    if (totalNodes >= 100 || value === null || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const child of value) visit(child);
      return;
    }
    const node = value as Record<string, unknown>;
    totalNodes += 1;
    if (typeof node.type === 'number') {
      const name = componentTypeName(node.type);
      typeCounts[name] = (typeCounts[name] ?? 0) + 1;
      if (INTERACTIVE_TYPES.has(node.type)) interactiveCount += 1;
    }
    if (typeof node.content === 'string') {
      textNodes += 1;
      maxTextLength = Math.max(maxTextLength, node.content.length);
    }
    if (typeof node.custom_id === 'string') {
      customIdLengths.push(node.custom_id.length);
      customIdHashes.push(fingerprintPayload({ custom_id: node.custom_id }).slice(0, 16));
    }
    const inspectUrl = (raw: unknown): void => {
      if (typeof raw !== 'string' || !URL_RE.test(raw)) return;
      try {
        const host = new URL(raw).hostname;
        if (host.length > 0 && externalUrlHosts.size < 20) externalUrlHosts.add(host);
      } catch {
        // The Components V2 validator reports malformed URLs separately.
      }
    };
    inspectUrl(node.url);
    if (isRecord(node.media)) inspectUrl(node.media.url);
    if (isRecord(node.file)) inspectUrl(node.file.url);
    for (const child of Object.values(node)) visit(child);
  };
  visit(components);
  return {
    totalNodes,
    typeCounts,
    textNodes,
    maxTextLength,
    externalUrlHosts: [...externalUrlHosts].sort(),
    interactiveCount,
    customIdLengths,
    customIdHashes,
  };
}

/** Classify only the bounded, validated shape used by Components V2 writes. */
export function assessComponentsV2Payload(
  toolName: string,
  args: Record<string, unknown>,
): ComponentsV2RiskAssessment {
  const components = Array.isArray(args.components) ? args.components : [];
  const state = { externalUrl: false, interactive: false };
  inspectValue(components, state);
  const riskFlags: string[] = [];
  if (toolName === 'components_v2_edit') riskFlags.push('edit_existing_message');
  if (args.allowed_mentions !== undefined) riskFlags.push('allowed_mentions');
  if (state.externalUrl) riskFlags.push('external_urls');
  if (state.interactive) riskFlags.push('interactive_components');
  if (components.length >= 32 || reviewComponentsV2(components).totalNodes >= 32) {
    riskFlags.push('component_count_near_limit');
  }
  return { componentCount: components.length, riskFlags };
}

function getRawArgs(ctx: MiddlewareContext<unknown>): Record<string, unknown> {
  const raw = ctx.meta.get('rawArgs');
  return isRecord(raw) ? raw : {};
}

function buildPreview(
  toolName: string,
  args: Record<string, unknown>,
  payloadHash: string,
  assessment: ComponentsV2RiskAssessment,
  componentReview: ComponentsV2Review,
  approval: { approvalId: string; expiresAt: number },
): Record<string, unknown> {
  const payload = redactArgs(args, toolName);
  delete payload.__confirm;
  delete payload.__confirm_hash;
  delete payload.__confirm_id;
  return {
    tool: toolName,
    target: {
      channel_id: args.channel_id ?? null,
      ...(toolName === 'components_v2_edit' ? { message_id: args.message_id ?? null } : {}),
    },
    component_count: assessment.componentCount,
    risk_flags: [...assessment.riskFlags],
    component_review: componentReview,
    payload_hash: payloadHash,
    approval_id: approval.approvalId,
    approval_expires_at: new Date(approval.expiresAt).toISOString(),
    payload,
  };
}

function validatedComponents(
  args: unknown,
  toolName: string,
): { readonly hashArgs: Record<string, unknown>; readonly components: readonly unknown[] } {
  if (!isRecord(args)) {
    throw new ValidationError([
      { path: 'components', message: 'Components V2 arguments must be an object.', code: 'TYPE' },
    ]);
  }
  const components =
    toolName === 'components_v2_send_from_template'
      ? (() => {
          const template = TEMPLATES[typeof args.template === 'string' ? args.template : ''];
          return isRecord(template) && Array.isArray(template.components)
            ? interpolateTemplate(
                template.components,
                (isRecord(args.vars) ? args.vars : {}) as Record<string, string>,
              )
            : [];
        })()
      : args.components;
  const validation = validateComponentsV2(components);
  if (!validation.valid) {
    throw new ValidationError(
      validation.issues.map((issue) => ({
        path: issue.path,
        message: issue.message,
        code: issue.code,
      })),
    );
  }
  // The middleware runs after zod validation; preserve the exact parsed object
  // while keeping this helper's contract explicit for direct unit tests.
  return {
    hashArgs:
      toolName === 'components_v2_send_from_template'
        ? { channel_id: args.channel_id, components }
        : args,
    components: Array.isArray(components) ? components : [],
  };
}

/**
 * Bind an approval to the exact Components V2 payload. This is deliberately a
 * narrow policy seam: legacy destructive tools retain their existing
 * `ConfirmRequired` contract until each payload has an equivalent review.
 */
export function payloadConfirmationMiddleware(
  options: PayloadConfirmationOptions = {},
): ToolMiddleware {
  const env = options.env ?? process.env;
  const ledger = options.ledger ?? new PayloadApprovalLedger(Date.now, options.approvalTtlMs);
  return {
    async onCallTool(ctx, next) {
      const toolPiece = ctx.meta.get('toolPiece') as { confirmation?: string } | undefined;
      if (
        toolPiece?.confirmation !== PAYLOAD_CONFIRMATION_KIND &&
        !PAYLOAD_CONFIRMATION_TOOL_NAMES.has(ctx.tool.name)
      ) {
        return next();
      }

      const args = isRecord(ctx.args) ? ctx.args : {};
      const validated = validatedComponents(args, ctx.tool.name);
      const assessment = assessComponentsV2Payload(ctx.tool.name, {
        ...args,
        components: validated.components,
      });
      const payloadHash = fingerprintPayload(validated.hashArgs);
      const componentReview = reviewComponentsV2(validated.components);
      const target = canonicalTarget(args, ctx.tool.name);
      const binding = {
        tool: ctx.tool.name,
        payloadHash,
        target,
        ...(options.botId === undefined ? {} : { botId: options.botId }),
      } satisfies PayloadApprovalBinding;
      const raw = getRawArgs(ctx);
      const receivedHash = typeof raw.__confirm_hash === 'string' ? raw.__confirm_hash : '';
      const receivedApprovalId = typeof raw.__confirm_id === 'string' ? raw.__confirm_id : '';

      if (env.MCP_DRY_RUN !== 'false' || raw.__confirm !== true || receivedHash === '') {
        const approval = ledger.issue(binding);
        const preview = buildPreview(
          ctx.tool.name,
          args,
          payloadHash,
          assessment,
          componentReview,
          approval,
        );
        throw new PayloadConfirmationRequired(
          ctx.tool.name,
          payloadHash,
          assessment.riskFlags,
          preview,
          approval.approvalId,
          approval.expiresAt,
        );
      }

      if (!HASH_RE.test(receivedHash) || receivedHash !== payloadHash) {
        const approval = ledger.issue(binding);
        const preview = buildPreview(
          ctx.tool.name,
          args,
          payloadHash,
          assessment,
          componentReview,
          approval,
        );
        throw new PayloadConfirmationMismatch(
          ctx.tool.name,
          payloadHash,
          HASH_RE.test(receivedHash) ? receivedHash : '[invalid]',
          assessment.riskFlags,
          preview,
        );
      }
      if (receivedApprovalId === '') {
        const approval = ledger.issue(binding);
        const preview = buildPreview(
          ctx.tool.name,
          args,
          payloadHash,
          assessment,
          componentReview,
          approval,
        );
        throw new PayloadConfirmationRequired(
          ctx.tool.name,
          payloadHash,
          assessment.riskFlags,
          preview,
          approval.approvalId,
          approval.expiresAt,
        );
      }
      const state = ledger.consume(receivedApprovalId, binding);
      if (state === 'missing')
        throw new PayloadConfirmationApprovalMissing(ctx.tool.name, receivedApprovalId);
      if (state === 'expired')
        throw new PayloadConfirmationApprovalExpired(ctx.tool.name, receivedApprovalId);
      if (state === 'replayed')
        throw new PayloadConfirmationApprovalReplayed(ctx.tool.name, receivedApprovalId);
      if (state === 'mismatch')
        throw new PayloadConfirmationApprovalMismatch(ctx.tool.name, receivedApprovalId);
      return next();
    },
  };
}
