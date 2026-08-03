/**
 * Local, privacy-safe evidence for caller-owned onboarding.
 *
 * This is deliberately not product telemetry: records never leave the
 * caller's machine and contain no token, Discord identity, guild ID, path,
 * raw error, or command argument. The journal lets an operator see whether
 * setup, doctor, and first smoke runs are actually succeeding before the
 * project makes broader onboarding decisions.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { CommandResult } from './output.js';
import { type ProfileLocationOptions, resolveProfileDirectory } from './profiles.js';

const ACTIVITY_VERSION = 1;
export const ACTIVITY_RETENTION = 200;
const RECENT_ACTIVITY_LIMIT = 10;
const ACTIVITY_COMMANDS = ['setup', 'doctor', 'smoke'] as const;
const ACTIVITY_OUTCOMES = ['success', 'warning', 'failure'] as const;

export type ActivityCommand = (typeof ACTIVITY_COMMANDS)[number];
export type ActivityOutcome = (typeof ACTIVITY_OUTCOMES)[number];

export interface ActivityEvent {
  readonly version: 1;
  readonly at: string;
  readonly command: ActivityCommand;
  readonly outcome: ActivityOutcome;
  readonly signals: readonly string[];
}

export interface ActivityContext extends ProfileLocationOptions {
  readonly command: ActivityCommand;
  readonly online?: boolean;
  readonly confirmWrite?: boolean;
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

function parseActivityEvent(value: unknown): ActivityEvent | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    record.version !== ACTIVITY_VERSION ||
    typeof record.at !== 'string' ||
    Number.isNaN(Date.parse(record.at)) ||
    !isActivityCommand(record.command) ||
    !isActivityOutcome(record.outcome) ||
    !Array.isArray(record.signals) ||
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
  return join(dirname(resolveProfileDirectory(options)), 'activity.jsonl');
}

export function readActivity(options: ProfileLocationOptions = {}): ActivityEvent[] {
  const path = resolveActivityPath(options);
  if (!existsSync(path)) return [];
  try {
    return readFileSync(path, 'utf8')
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
  } catch {
    return [];
  }
}

function writeActivity(events: readonly ActivityEvent[], options: ProfileLocationOptions): void {
  const path = resolveActivityPath(options);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
}

export function recordActivity(event: ActivityEvent, options: ProfileLocationOptions = {}): void {
  try {
    const existing = readActivity(options);
    const retained = [...existing, event].slice(-ACTIVITY_RETENTION);
    if (existing.length >= ACTIVITY_RETENTION) {
      writeActivity(retained, options);
      return;
    }

    const path = resolveActivityPath(options);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    appendFileSync(path, `${JSON.stringify(event)}\n`, { encoding: 'utf8', mode: 0o600 });
  } catch {
    // Activity evidence must never change a command's visible result.
  }
}

function outcomeFor(result: CommandResult): ActivityOutcome {
  if (result.exitCode === 0) return 'success';
  return result.exitCode === 1 ? 'warning' : 'failure';
}

function setupSignals(result: CommandResult): string[] {
  if (result.exitCode === 0 || result.exitCode === 1) return ['profile-config-generated'];
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

function smokeSignals(result: CommandResult, confirmWrite: boolean): string[] {
  const data = result.data ?? {};
  const steps =
    data.steps !== null && typeof data.steps === 'object' && !Array.isArray(data.steps)
      ? (data.steps as Record<string, unknown>)
      : {};
  const signals = [confirmWrite ? 'write-confirmed' : 'read-only'];
  if (steps.identityRead === true) signals.push('identity-read');
  if (steps.guildsRead === true) signals.push('guilds-read');
  if (steps.channelCreated === true) signals.push('channel-created');
  if (steps.messageSent === true) signals.push('message-sent');
  if (data.cleanupComplete === true) signals.push('cleanup-complete');
  return signals;
}

function signalsFor(context: ActivityContext, result: CommandResult): string[] {
  if (context.command === 'setup') return setupSignals(result);
  if (context.command === 'doctor') return doctorSignals(result, context.online === true);
  return smokeSignals(result, context.confirmWrite === true);
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
  readonly recent: readonly ActivityEvent[];
}

export function summarizeActivity(events: readonly ActivityEvent[]): ActivitySummary {
  const commands = Object.fromEntries(
    ACTIVITY_COMMANDS.map((command) => [
      command,
      { success: 0, warning: 0, failure: 0 } satisfies Record<ActivityOutcome, number>,
    ]),
  ) as Record<ActivityCommand, Record<ActivityOutcome, number>>;
  for (const event of events) commands[event.command][event.outcome] += 1;
  return {
    total: events.length,
    retention: ACTIVITY_RETENTION,
    commands,
    recent: events.slice(-RECENT_ACTIVITY_LIMIT).reverse(),
  };
}
