import { createHash } from 'node:crypto';
import {
  type DiscordAccessRequirement,
  type DiscordPermissionName,
  resolveToolAccessRequirement,
} from './requirements.js';

export type DiscordIntent = 'lock_channel' | 'announce' | 'verify' | 'lock_and_announce';

export interface IntentPlanRequest {
  readonly intent: DiscordIntent | string;
  readonly guild_id: string;
  readonly channel_id: string;
  readonly announcement?: string;
  readonly allow?: string;
  readonly deny?: string;
}

export interface IntentPlanStep {
  readonly id: string;
  readonly action: 'prepare' | 'write' | 'verify';
  readonly tool: string;
  readonly purpose: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly access: DiscordAccessRequirement;
  readonly depends_on: readonly string[];
  readonly requires_approval: boolean;
}

export interface DiscordIntentPlan {
  readonly schema_version: 'discord_intent_plan.v1';
  readonly status: 'ready' | 'needs_input' | 'unsupported';
  readonly intent: DiscordIntent | null;
  readonly target: { readonly guild_id: string; readonly channel_id: string };
  readonly steps: readonly IntentPlanStep[];
  readonly access: {
    readonly permissions: readonly DiscordPermissionName[];
    readonly scopes: readonly string[];
  };
  readonly approval_boundary: 'per_write' | 'none';
  readonly verification_step_id: string | null;
  readonly plan_digest: string;
  readonly warnings: readonly string[];
}

function normalizeIntent(value: string): DiscordIntent | null {
  const normalized = value
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[ -]+/g, '_');
  const aliases: Readonly<Record<string, DiscordIntent>> = {
    khoa_kenh: 'lock_channel',
    thong_bao: 'announce',
    xac_minh: 'verify',
    kiem_tra: 'verify',
    khoa_kenh_va_thong_bao: 'lock_and_announce',
    khoa_va_thong_bao: 'lock_and_announce',
  };
  const alias = aliases[normalized];
  if (alias !== undefined) return alias;
  if (normalized === 'lock_channel' || normalized === 'announce' || normalized === 'verify') {
    return normalized;
  }
  if (
    normalized === 'lock_and_announce' ||
    normalized === 'announce_and_lock' ||
    normalized === 'lock_channel_and_announce'
  ) {
    return 'lock_and_announce';
  }
  return null;
}

function accessFor(tool: string, args: Record<string, unknown>): DiscordAccessRequirement {
  const requirement = resolveToolAccessRequirement(tool, args);
  if (requirement === null) {
    // The registry invariant prevents this for shipped steps. If a future
    // planner step is added without an access contract, fail closed rather
    // than emitting a plan that silently widens permissions.
    throw new Error(`No access contract is registered for planner step ${tool}`);
  }
  return requirement;
}

function canonicalDigest(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function isPermissionBits(value: string | undefined): boolean {
  return value === undefined || /^\d+$/u.test(value);
}

/**
 * Convert a deliberately small set of explicit intents into a reviewable plan.
 * This function never talks to Discord and never returns executable payloads
 * for permission changes; callers must still construct and approve each write.
 */
export function planDiscordIntent(request: IntentPlanRequest): DiscordIntentPlan {
  const intent = normalizeIntent(request.intent);
  const target = { guild_id: request.guild_id, channel_id: request.channel_id };
  if (intent === null) {
    const base = {
      schema_version: 'discord_intent_plan.v1' as const,
      status: 'unsupported' as const,
      intent: null,
      target,
      steps: [] as const,
      access: { permissions: [] as const, scopes: ['guild', 'channel'] as const },
      approval_boundary: 'none' as const,
      verification_step_id: null,
      warnings: [
        'Only lock_channel, announce, verify, and lock_and_announce are supported.',
      ] as const,
    };
    return { ...base, plan_digest: canonicalDigest(base) };
  }

  if ((intent === 'announce' || intent === 'lock_and_announce') && !request.announcement?.trim()) {
    const base = {
      schema_version: 'discord_intent_plan.v1' as const,
      status: 'needs_input' as const,
      intent,
      target,
      steps: [] as const,
      access: { permissions: [] as const, scopes: ['guild', 'channel'] as const },
      approval_boundary: 'none' as const,
      verification_step_id: null,
      warnings: [
        'announcement is required for announce intents; no invalid message step was emitted.',
      ] as const,
    };
    return { ...base, plan_digest: canonicalDigest(base) };
  }

  if (
    (intent === 'lock_channel' || intent === 'lock_and_announce') &&
    request.allow === undefined &&
    request.deny === undefined
  ) {
    const base = {
      schema_version: 'discord_intent_plan.v1' as const,
      status: 'needs_input' as const,
      intent,
      target,
      steps: [] as const,
      access: { permissions: [] as const, scopes: ['guild', 'channel'] as const },
      approval_boundary: 'none' as const,
      verification_step_id: null,
      warnings: [
        'allow or deny is required for lock intents; no guessed permission bits were emitted.',
      ] as const,
    };
    return { ...base, plan_digest: canonicalDigest(base) };
  }

  if (!isPermissionBits(request.allow) || !isPermissionBits(request.deny)) {
    const base = {
      schema_version: 'discord_intent_plan.v1' as const,
      status: 'needs_input' as const,
      intent,
      target,
      steps: [] as const,
      access: { permissions: [] as const, scopes: ['guild', 'channel'] as const },
      approval_boundary: 'none' as const,
      verification_step_id: null,
      warnings: ['allow and deny must be base-10 Discord permission bitfields.'] as const,
    };
    return { ...base, plan_digest: canonicalDigest(base) };
  }

  if (
    request.allow !== undefined &&
    request.deny !== undefined &&
    (BigInt(request.allow) & BigInt(request.deny)) !== 0n
  ) {
    const base = {
      schema_version: 'discord_intent_plan.v1' as const,
      status: 'needs_input' as const,
      intent,
      target,
      steps: [] as const,
      access: { permissions: [] as const, scopes: ['guild', 'channel'] as const },
      approval_boundary: 'none' as const,
      verification_step_id: null,
      warnings: ['allow and deny cannot contain overlapping permission bits.'] as const,
    };
    return { ...base, plan_digest: canonicalDigest(base) };
  }

  const steps: IntentPlanStep[] = [];
  if (intent === 'lock_channel' || intent === 'lock_and_announce') {
    // Discord's @everyone role has the same snowflake as its guild. This keeps
    // the preview structurally valid while still requiring caller review.
    const args = {
      channel_id: request.channel_id,
      overwrite_id: request.guild_id,
      type: 0,
      ...(request.allow === undefined ? {} : { allow: request.allow }),
      ...(request.deny === undefined ? {} : { deny: request.deny }),
    };
    steps.push({
      id: 'lock-channel',
      action: 'write',
      tool: 'channels_modify_permissions',
      purpose: 'Apply the caller-approved channel restriction overwrite.',
      args,
      access: accessFor('channels_modify_permissions', args),
      depends_on: [],
      requires_approval: true,
    });
  }
  if (intent === 'announce' || intent === 'lock_and_announce') {
    const args = { channel_id: request.channel_id, content: request.announcement ?? '' };
    steps.push({
      id: 'announce',
      action: 'write',
      tool: 'messages_send',
      purpose: 'Send the caller-provided announcement after explicit approval.',
      args,
      access: accessFor('messages_send', args),
      depends_on: intent === 'lock_and_announce' ? ['lock-channel'] : [],
      requires_approval: true,
    });
  }
  if (intent === 'verify' || intent === 'lock_and_announce') {
    const args = { guild_id: request.guild_id, channel_id: request.channel_id };
    steps.push({
      id: 'verify-channel',
      action: 'verify',
      tool: 'permissions_audit_channel',
      purpose: 'Re-read effective channel permissions after any approved writes.',
      args,
      access: accessFor('permissions_audit_channel', args),
      depends_on: steps.filter((step) => step.action === 'write').map((step) => step.id),
      requires_approval: false,
    });
  }
  const permissions = [...new Set(steps.flatMap((step) => step.access.permissions))].sort();
  const approvalBoundary: DiscordIntentPlan['approval_boundary'] = steps.some(
    (step) => step.requires_approval,
  )
    ? 'per_write'
    : 'none';
  const base = {
    schema_version: 'discord_intent_plan.v1' as const,
    status: 'ready' as const,
    intent,
    target,
    steps,
    access: { permissions, scopes: ['guild', 'channel'] as const },
    approval_boundary: approvalBoundary,
    verification_step_id: steps.find((step) => step.action === 'verify')?.id ?? null,
    warnings: [
      'Read-only planning only: the planner made no Discord request and no step is authorized by this result.',
      'The guild/channel relationship is not verified by the local planner; execution must re-resolve every target through the server scope middleware.',
      'Write steps require the normal server approval/dry-run gates; verification is an independent readback step.',
      'The @everyone overwrite targets the guild snowflake by Discord convention; callers must review the allow/deny bits before execution.',
    ] as const,
  };
  return { ...base, plan_digest: canonicalDigest(base) };
}
