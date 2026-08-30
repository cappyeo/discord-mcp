/**
 * Local, privacy-safe evidence for caller-owned onboarding.
 *
 * This is deliberately not product telemetry: records never leave the
 * caller's machine and contain no token, Discord identity, guild ID, path,
 * raw error, or command argument. The journal lets an operator see whether
 * setup, doctor, smoke, and blueprint lifecycle calls are succeeding before
 * the project makes broader onboarding and adoption decisions.
 */
import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  type Stats,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import type { BlueprintLifecycleObservation } from '@discord-mcp/core';
import type { CommandResult } from './output.js';
import { type ProfileLocationOptions, resolveProfileDirectory } from './profiles.js';

const ACTIVITY_VERSION = 1;
const BLUEPRINT_ACTIVITY_VERSION = 2;
export const ACTIVITY_RETENTION = 200;
const RECENT_ACTIVITY_LIMIT = 10;
const MAX_ACTIVITY_BYTES = 1024 * 1024;
const ACTIVITY_FILE_NAME = 'activity.jsonl';
const ACTIVITY_LOCK_NAME = '.activity.lock';
const ACTIVITY_LOCK_STALE_MS = 30_000;
const MAX_ACTIVITY_LOCK_BYTES = 32;
const ACTIVITY_COMMANDS = ['setup', 'doctor', 'smoke'] as const;
const ACTIVITY_OUTCOMES = ['success', 'warning', 'failure'] as const;
const BLUEPRINT_ACTIVITY_STAGES = ['plan', 'apply', 'evidence'] as const;
const BLUEPRINT_ACTIVITY_STATUSES = [
  'ready',
  'already_current',
  'complete',
  'partial',
  'busy',
  'stale',
  'verified',
  'drifted',
  'not_found',
  'blocked',
  'no_match',
  'error',
] as const;
const BLUEPRINT_ACTIVITY_TRANSPORTS = ['stdio', 'http'] as const;
const BLUEPRINT_ACTIVITY_OUTCOMES = [
  'success',
  'in_progress',
  'blocked',
  'drifted',
  'failure',
] as const;

export type ActivityCommand = (typeof ACTIVITY_COMMANDS)[number];
export type ActivityOutcome = (typeof ACTIVITY_OUTCOMES)[number];
export type BlueprintActivityStage = (typeof BLUEPRINT_ACTIVITY_STAGES)[number];
export type BlueprintActivityStatus = (typeof BLUEPRINT_ACTIVITY_STATUSES)[number];
export type BlueprintActivityTransport = (typeof BLUEPRINT_ACTIVITY_TRANSPORTS)[number];
export type BlueprintActivityOutcome = (typeof BLUEPRINT_ACTIVITY_OUTCOMES)[number];

export interface LegacyActivityEvent {
  readonly version: 1;
  readonly at: string;
  readonly command: ActivityCommand;
  readonly outcome: ActivityOutcome;
  readonly signals: readonly string[];
}

export interface BlueprintActivityEvent {
  readonly version: 2;
  readonly kind: 'blueprint';
  readonly at: string;
  readonly stage: BlueprintActivityStage;
  readonly status: BlueprintActivityStatus;
  readonly outcome: BlueprintActivityOutcome;
  readonly transport: BlueprintActivityTransport;
}

export type ActivityEvent = LegacyActivityEvent | BlueprintActivityEvent;

export type BlueprintActivityObservation = BlueprintLifecycleObservation;

export interface ActivityContext extends ProfileLocationOptions {
  readonly command: ActivityCommand;
  readonly online?: boolean;
  readonly confirmWrite?: boolean;
  readonly confirmTemplateLifecycle?: boolean;
}

interface ActivitySession {
  readonly context: ActivityContext;
  emitted: boolean;
}

let activeSession: ActivitySession | undefined;

function isActivityCommand(value: unknown): value is ActivityCommand {
  return typeof value === 'string' && ACTIVITY_COMMANDS.includes(value as ActivityCommand);
}

function isActivityOutcome(value: unknown): value is ActivityOutcome {
  return typeof value === 'string' && ACTIVITY_OUTCOMES.includes(value as ActivityOutcome);
}

function isBlueprintActivityStage(value: unknown): value is BlueprintActivityStage {
  return (
    typeof value === 'string' && BLUEPRINT_ACTIVITY_STAGES.includes(value as BlueprintActivityStage)
  );
}

function isBlueprintActivityStatus(value: unknown): value is BlueprintActivityStatus {
  return (
    typeof value === 'string' &&
    BLUEPRINT_ACTIVITY_STATUSES.includes(value as BlueprintActivityStatus)
  );
}

function isBlueprintActivityTransport(value: unknown): value is BlueprintActivityTransport {
  return (
    typeof value === 'string' &&
    BLUEPRINT_ACTIVITY_TRANSPORTS.includes(value as BlueprintActivityTransport)
  );
}

function isBlueprintActivityOutcome(value: unknown): value is BlueprintActivityOutcome {
  return (
    typeof value === 'string' &&
    BLUEPRINT_ACTIVITY_OUTCOMES.includes(value as BlueprintActivityOutcome)
  );
}

function parseActivityEvent(value: unknown): ActivityEvent | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.version === BLUEPRINT_ACTIVITY_VERSION && record.kind === 'blueprint') {
    if (
      typeof record.at !== 'string' ||
      Number.isNaN(Date.parse(record.at)) ||
      !isBlueprintActivityStage(record.stage) ||
      !isBlueprintActivityStatus(record.status) ||
      !isBlueprintActivityOutcome(record.outcome) ||
      !isBlueprintActivityTransport(record.transport)
    ) {
      return undefined;
    }
    return {
      version: BLUEPRINT_ACTIVITY_VERSION,
      kind: 'blueprint',
      at: record.at,
      stage: record.stage,
      status: record.status,
      outcome: record.outcome,
      transport: record.transport,
    };
  }
  if (
    record.version !== ACTIVITY_VERSION ||
    typeof record.at !== 'string' ||
    Number.isNaN(Date.parse(record.at)) ||
    !isActivityCommand(record.command) ||
    !isActivityOutcome(record.outcome) ||
    !Array.isArray(record.signals) ||
    record.signals.length > 64 ||
    record.signals.some((signal) => typeof signal !== 'string' || signal.length > 80)
  ) {
    return undefined;
  }
  return {
    version: ACTIVITY_VERSION,
    at: record.at,
    command: record.command,
    outcome: record.outcome,
    signals: [...record.signals] as string[],
  };
}

export function resolveActivityPath(options: ProfileLocationOptions = {}): string {
  return join(dirname(resolveProfileDirectory(options)), ACTIVITY_FILE_NAME);
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

function sameFileIdentity(expected: Stats, actual: Stats): boolean {
  if (expected.ino !== actual.ino || expected.ino === 0) return false;
  if (expected.dev === actual.dev) return true;
  return process.platform === 'win32' && (expected.dev === 0 || actual.dev === 0);
}

function canonicalActivityDirectory(directory: string): string | undefined {
  let metadata: Stats;
  try {
    metadata = lstatSync(directory);
  } catch (error) {
    if (missing(error)) return undefined;
    throw error;
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error('Activity directory must be a regular directory');
  }
  return realpathSync(directory);
}

function ensureActivityDirectory(directory: string): string {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const canonical = canonicalActivityDirectory(directory);
  if (canonical === undefined) {
    throw new Error('Activity directory disappeared while opening');
  }
  return canonical;
}

function inspectActivityFile(path: string): Stats | undefined {
  let metadata: Stats;
  try {
    metadata = lstatSync(path);
  } catch (error) {
    if (missing(error)) return undefined;
    throw error;
  }
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size > MAX_ACTIVITY_BYTES) {
    throw new Error('Activity journal must be a bounded regular file');
  }
  return metadata;
}

function openVerifiedActivity(path: string, flags: number): number | undefined {
  const expected = inspectActivityFile(path);
  if (expected === undefined) return undefined;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, flags | (fsConstants.O_NOFOLLOW ?? 0));
    const actual = fstatSync(descriptor);
    if (!actual.isFile() || !sameFileIdentity(expected, actual)) {
      throw new Error('Activity journal changed while opening');
    }
    return descriptor;
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    throw error;
  }
}

function openActivityForAppend(path: string): number {
  const existing = openVerifiedActivity(path, fsConstants.O_WRONLY | fsConstants.O_APPEND);
  if (existing !== undefined) return existing;

  try {
    const descriptor = openSync(
      path,
      fsConstants.O_WRONLY |
        fsConstants.O_APPEND |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        (fsConstants.O_NOFOLLOW ?? 0),
      0o600,
    );
    try {
      if (!fstatSync(descriptor).isFile()) throw new Error('Activity journal is not a file');
      return descriptor;
    } catch (error) {
      closeSync(descriptor);
      throw error;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code !== 'EEXIST') throw error;
    const raced = openVerifiedActivity(path, fsConstants.O_WRONLY | fsConstants.O_APPEND);
    if (raced === undefined) throw new Error('Activity journal disappeared while opening');
    return raced;
  }
}

function readActivityText(path: string): string | undefined {
  const descriptor = openVerifiedActivity(path, fsConstants.O_RDONLY);
  if (descriptor === undefined) return undefined;
  try {
    return readFileSync(descriptor, 'utf8');
  } finally {
    closeSync(descriptor);
  }
}

function parseActivityText(text: string): ActivityEvent[] {
  return text
    .split('\n')
    .filter((line) => line.length > 0)
    .flatMap((line) => {
      try {
        const event = parseActivityEvent(JSON.parse(line));
        return event === undefined ? [] : [event];
      } catch {
        return [];
      }
    });
}

interface ActivityLock {
  readonly path: string;
  readonly identity: Stats;
}

function createActivityLock(path: string): ActivityLock | undefined {
  let descriptor: number;
  try {
    descriptor = openSync(
      path,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        (fsConstants.O_NOFOLLOW ?? 0),
      0o600,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === 'EEXIST') return undefined;
    throw error;
  }
  try {
    writeFileSync(descriptor, `${process.pid}\n`, { encoding: 'utf8' });
    fsyncSync(descriptor);
    const identity = fstatSync(descriptor);
    if (!identity.isFile()) throw new Error('Activity lock is not a regular file');
    return { path, identity };
  } finally {
    closeSync(descriptor);
  }
}

function reclaimStaleActivityLock(path: string): boolean {
  let first: Stats;
  try {
    first = lstatSync(path);
  } catch (error) {
    if (missing(error)) return false;
    throw error;
  }
  if (
    first.isSymbolicLink() ||
    !first.isFile() ||
    first.size > MAX_ACTIVITY_LOCK_BYTES ||
    Date.now() - first.mtimeMs <= ACTIVITY_LOCK_STALE_MS
  ) {
    return false;
  }
  let descriptor: number | undefined;
  let ownerText: string;
  try {
    descriptor = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || !sameFileIdentity(first, opened)) return false;
    ownerText = readFileSync(descriptor, 'utf8').trim();
  } catch (error) {
    if (missing(error)) return false;
    throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  const ownerPid = Number(ownerText);
  if (!/^\d{1,10}$/.test(ownerText) || !Number.isSafeInteger(ownerPid) || ownerPid <= 0) {
    return false;
  }
  try {
    process.kill(ownerPid, 0);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code !== 'ESRCH') return false;
  }
  let current: Stats;
  try {
    current = lstatSync(path);
  } catch (error) {
    if (missing(error)) return false;
    throw error;
  }
  if (!sameFileIdentity(first, current)) return false;
  unlinkSync(path);
  return true;
}

function acquireActivityLock(directory: string): ActivityLock {
  const path = join(directory, ACTIVITY_LOCK_NAME);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const lock = createActivityLock(path);
    if (lock !== undefined) return lock;
    if (attempt === 0 && reclaimStaleActivityLock(path)) continue;
    break;
  }
  throw new Error('Activity journal is busy');
}

function releaseActivityLock(lock: ActivityLock): void {
  let current: Stats;
  try {
    current = lstatSync(lock.path);
  } catch (error) {
    if (missing(error)) return;
    throw error;
  }
  if (current.isSymbolicLink() || !sameFileIdentity(lock.identity, current)) return;
  unlinkSync(lock.path);
}

export function readActivity(options: ProfileLocationOptions = {}): ActivityEvent[] {
  const requested = resolveActivityPath(options);
  try {
    const directory = canonicalActivityDirectory(dirname(requested));
    if (directory === undefined) return [];
    return parseActivityText(readActivityText(join(directory, ACTIVITY_FILE_NAME)) ?? '');
  } catch {
    return [];
  }
}

function writeActivity(events: readonly ActivityEvent[], path: string, directory: string): void {
  inspectActivityFile(path);
  const content = `${events.map((event) => JSON.stringify(event)).join('\n')}\n`;
  if (Buffer.byteLength(content, 'utf8') > MAX_ACTIVITY_BYTES) {
    throw new Error('Compacted activity journal is too large');
  }
  const temporary = join(directory, `.activity.${process.pid}.${randomUUID()}.tmp`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      temporary,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        (fsConstants.O_NOFOLLOW ?? 0),
      0o600,
    );
    writeFileSync(descriptor, content, { encoding: 'utf8' });
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    inspectActivityFile(path);
    renameSync(temporary, path);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    try {
      unlinkSync(temporary);
    } catch {
      // Best-effort cleanup must not replace the original journal error.
    }
  }
}

export function recordActivity(event: ActivityEvent, options: ProfileLocationOptions = {}): void {
  try {
    const normalized = parseActivityEvent(event);
    if (normalized === undefined) return;
    const requested = resolveActivityPath(options);
    const directory = ensureActivityDirectory(dirname(requested));
    const path = join(directory, ACTIVITY_FILE_NAME);
    const lock = acquireActivityLock(directory);
    try {
      const existing = parseActivityText(readActivityText(path) ?? '');
      const retained = [...existing, normalized].slice(-ACTIVITY_RETENTION);
      if (existing.length >= ACTIVITY_RETENTION) {
        writeActivity(retained, path, directory);
        return;
      }

      const line = `${JSON.stringify(normalized)}\n`;
      const descriptor = openActivityForAppend(path);
      try {
        const currentSize = fstatSync(descriptor).size;
        if (currentSize + Buffer.byteLength(line, 'utf8') > MAX_ACTIVITY_BYTES) {
          throw new Error('Activity journal is too large');
        }
        appendFileSync(descriptor, line, { encoding: 'utf8' });
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
    } finally {
      releaseActivityLock(lock);
    }
  } catch {
    // Activity evidence must never change a command's visible result.
  }
}

/**
 * Record one coarse blueprint lifecycle observation. The event is rebuilt from
 * the allowlisted observation fields so raw MCP arguments/results can never
 * enter the local journal through this API.
 */
export function recordBlueprintActivity(
  observation: BlueprintActivityObservation,
  options: ProfileLocationOptions = {},
): void {
  if (process.env.DISCORD_MCP_ACTIVITY === 'off') return;
  if (
    !isBlueprintActivityStage(observation.stage) ||
    !isBlueprintActivityStatus(observation.status) ||
    !isBlueprintActivityOutcome(observation.outcome) ||
    !isBlueprintActivityTransport(observation.transport)
  ) {
    return;
  }
  recordActivity(
    {
      version: BLUEPRINT_ACTIVITY_VERSION,
      kind: 'blueprint',
      at: new Date().toISOString(),
      stage: observation.stage,
      status: observation.status,
      outcome: observation.outcome,
      transport: observation.transport,
    },
    options,
  );
}

function outcomeFor(result: CommandResult): ActivityOutcome {
  if (result.exitCode === 0) return 'success';
  return result.exitCode === 1 ? 'warning' : 'failure';
}

function setupSignals(result: CommandResult): string[] {
  if (result.exitCode === 0) return ['profile-config-generated'];
  if (result.exitCode === 1) {
    const signals = ['profile-config-generated'];
    if (result.warnings?.some((warning) => warning.includes('Administrator'))) {
      signals.push('administrator-warning');
    }
    return signals;
  }
  const text = `${result.summary}\n${result.errors?.join('\n') ?? ''}`;
  if (text.includes('DISCORD_TOKEN')) return ['missing-launch-token'];
  if (text.includes('guild discovery failed')) return ['discord-discovery-failed'];
  if (text.includes('not installed in any guild')) return ['bot-has-no-guild'];
  if (text.includes('multiple guilds')) return ['guild-selection-required'];
  if (text.includes('already exists') || text.includes('locked to bot'))
    return ['profile-conflict'];
  if (text.includes('output') && text.includes('exists')) return ['config-write-protected'];
  return ['setup-failed'];
}

function doctorSignals(result: CommandResult, online: boolean): string[] {
  const checks = Array.isArray(result.data?.checks) ? result.data.checks : [];
  const statuses = checks.flatMap((value) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return [];
    const check = value as { id?: unknown; status?: unknown };
    return typeof check.id === 'string' && typeof check.status === 'string'
      ? [`check:${check.id}:${check.status}`]
      : [];
  });
  return [online ? 'online' : 'offline', ...statuses];
}

function smokeSignals(
  result: CommandResult,
  confirmWrite: boolean,
  confirmTemplateLifecycle: boolean,
): string[] {
  const data = result.data ?? {};
  const steps =
    data.steps !== null && typeof data.steps === 'object' && !Array.isArray(data.steps)
      ? (data.steps as Record<string, unknown>)
      : {};
  const signals = [confirmWrite ? 'write-confirmed' : 'read-only'];
  if (confirmTemplateLifecycle) signals.push('template-lifecycle-confirmed');
  if (steps.identityRead === true) signals.push('identity-read');
  if (steps.guildsRead === true) signals.push('guilds-read');
  if (steps.channelCreated === true) signals.push('channel-created');
  if (steps.messageSent === true) signals.push('message-sent');
  if (steps.templateCreated === true) signals.push('template-created');
  if (steps.templateDriftObserved === true) signals.push('template-drift-observed');
  if (steps.templateSynced === true) signals.push('template-synced');
  if (data.cleanupComplete === true) signals.push('cleanup-complete');
  return signals;
}

function signalsFor(context: ActivityContext, result: CommandResult): string[] {
  if (context.command === 'setup') return setupSignals(result);
  if (context.command === 'doctor') return doctorSignals(result, context.online === true);
  return smokeSignals(
    result,
    context.confirmWrite === true,
    context.confirmTemplateLifecycle === true,
  );
}

/**
 * Bind a single CLI invocation to the result emitted by `emitResult`.
 * Commands are one-shot and serial, so this scoped observer avoids passing
 * a recorder through every command's public API.
 */
export async function captureActivity<T>(
  context: ActivityContext,
  action: () => Promise<T>,
): Promise<T> {
  if (process.env.DISCORD_MCP_ACTIVITY === 'off') return action();
  const previous = activeSession;
  const session: ActivitySession = { context, emitted: false };
  activeSession = session;
  try {
    return await action();
  } catch (error) {
    if (!session.emitted) {
      session.emitted = true;
      recordActivity(
        {
          version: ACTIVITY_VERSION,
          at: new Date().toISOString(),
          command: context.command,
          outcome: 'failure',
          signals: ['handler-threw'],
        },
        context,
      );
    }
    throw error;
  } finally {
    activeSession = previous;
  }
}

export function observeCommandResult(result: CommandResult): void {
  const session = activeSession;
  if (session === undefined || session.emitted) return;
  session.emitted = true;
  recordActivity(
    {
      version: ACTIVITY_VERSION,
      at: new Date().toISOString(),
      command: session.context.command,
      outcome: outcomeFor(result),
      signals: signalsFor(session.context, result),
    },
    session.context,
  );
}

export interface ActivitySummary {
  readonly total: number;
  readonly retention: number;
  readonly commands: Record<ActivityCommand, Record<ActivityOutcome, number>>;
  readonly blueprint: {
    readonly total: number;
    readonly stages: Record<BlueprintActivityStage, number>;
    readonly outcomes: Record<BlueprintActivityOutcome, number>;
    readonly verifiedDays: number;
  };
  readonly recent: readonly ActivityEvent[];
}

export function summarizeActivity(events: readonly ActivityEvent[]): ActivitySummary {
  const commands = Object.fromEntries(
    ACTIVITY_COMMANDS.map((command) => [
      command,
      { success: 0, warning: 0, failure: 0 } satisfies Record<ActivityOutcome, number>,
    ]),
  ) as Record<ActivityCommand, Record<ActivityOutcome, number>>;
  const stages = Object.fromEntries(BLUEPRINT_ACTIVITY_STAGES.map((stage) => [stage, 0])) as Record<
    BlueprintActivityStage,
    number
  >;
  const outcomes = Object.fromEntries(
    BLUEPRINT_ACTIVITY_OUTCOMES.map((outcome) => [outcome, 0]),
  ) as Record<BlueprintActivityOutcome, number>;
  const verifiedDays = new Set<string>();
  let blueprintTotal = 0;
  for (const event of events) {
    if (event.version === BLUEPRINT_ACTIVITY_VERSION && event.kind === 'blueprint') {
      blueprintTotal += 1;
      stages[event.stage] += 1;
      outcomes[event.outcome] += 1;
      if (
        event.stage === 'evidence' &&
        event.status === 'verified' &&
        event.outcome === 'success'
      ) {
        verifiedDays.add(event.at.slice(0, 10));
      }
    } else if (event.version === ACTIVITY_VERSION) {
      commands[event.command][event.outcome] += 1;
    }
  }
  return {
    total: events.length,
    retention: ACTIVITY_RETENTION,
    commands,
    blueprint: {
      total: blueprintTotal,
      stages,
      outcomes,
      verifiedDays: verifiedDays.size,
    },
    recent: events.slice(-RECENT_ACTIVITY_LIMIT).reverse(),
  };
}
