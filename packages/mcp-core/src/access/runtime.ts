import {
  DISCORD_PERMISSION_BITS,
  type DiscordAccessRequirement,
  type DiscordPermissionName,
  type GatewayIntentName,
  getToolAccessRequirement,
  resolveToolAccessRequirement,
} from './requirements.js';

export type AccessMode = 'advisory' | 'warn' | 'enforce';
export type AccessEvidenceStatus = 'complete' | 'partial' | 'unknown';
export type HierarchyEvidenceStatus = 'satisfied' | 'not_satisfied' | 'unknown';

/** Already-fetched, privacy-safe evidence for one proposed tool target. */
export interface RuntimeAccessEvidence {
  readonly status: AccessEvidenceStatus;
  readonly identityVerified: boolean;
  readonly botId?: string;
  readonly target?: string;
  readonly effectivePermissions?: bigint;
  readonly intents?: Readonly<
    Partial<Record<GatewayIntentName, 'approved' | 'missing' | 'unknown'>>
  >;
  /** Required only for contracts whose action target must be below the bot's top role. */
  readonly hierarchy?: HierarchyEvidenceStatus;
}

export interface RuntimeAccessRequest {
  readonly toolName: string;
  readonly args: unknown;
  readonly requirement: DiscordAccessRequirement;
  readonly expectedBotId?: string;
  readonly signal?: AbortSignal;
}

export type RuntimeAccessResolver = (
  request: RuntimeAccessRequest,
) => Promise<RuntimeAccessEvidence>;

export interface RuntimeAccessDecision {
  readonly status: 'allowed' | 'denied' | 'unknown';
  readonly reason: string;
  readonly missingPermissions: readonly DiscordPermissionName[];
  readonly missingIntents: readonly GatewayIntentName[];
  readonly hierarchy: HierarchyEvidenceStatus;
}

/** Evaluate only evidence explicitly returned by a provider. */
export function evaluateRuntimeAccess(
  request: RuntimeAccessRequest,
  evidence: RuntimeAccessEvidence,
): RuntimeAccessDecision {
  if (!evidence.identityVerified) return unknownDecision('bot identity was not verified');
  if (request.expectedBotId !== undefined && evidence.botId !== request.expectedBotId) {
    return {
      ...unknownDecision('verified bot identity does not match the configured bot'),
      status: 'denied',
    };
  }
  if (evidence.status !== 'complete')
    return unknownDecision(`access evidence is ${evidence.status}`);

  const missingPermissions = request.requirement.permissions.filter((permission) => {
    const bits = evidence.effectivePermissions;
    return bits === undefined || (bits & DISCORD_PERMISSION_BITS[permission]) === 0n;
  });
  const unknownIntents = request.requirement.intents.filter(
    (intent) => evidence.intents?.[intent] === undefined || evidence.intents[intent] === 'unknown',
  );
  const missingIntents = request.requirement.intents.filter(
    (intent) => evidence.intents?.[intent] === 'missing',
  );
  if (unknownIntents.length > 0) {
    return unknownDecision(
      'complete identity and permission evidence did not prove the required Gateway intents',
      hierarchyForRequirement(request.requirement, evidence),
    );
  }
  const hierarchy = hierarchyForRequirement(request.requirement, evidence);
  if (hierarchy === 'unknown') {
    return unknownDecision(
      'role hierarchy evidence was not complete for the requested target',
      hierarchy,
    );
  }
  if (hierarchy === 'not_satisfied') {
    return {
      status: 'denied',
      reason: 'complete evidence proves the bot is below the requested target in role hierarchy',
      missingPermissions: [],
      missingIntents: [],
      hierarchy,
    };
  }
  if (missingPermissions.length > 0 || missingIntents.length > 0) {
    return {
      status: 'denied',
      reason: 'complete evidence proves one or more required permissions or intents are missing',
      missingPermissions,
      missingIntents,
      hierarchy,
    };
  }
  return {
    status: 'allowed',
    reason: 'complete evidence proves the declared access requirement',
    missingPermissions: [],
    missingIntents: [],
    hierarchy,
  };
}

function hierarchyForRequirement(
  requirement: DiscordAccessRequirement,
  evidence: RuntimeAccessEvidence,
): HierarchyEvidenceStatus {
  return requirement.hierarchy === 'required' ? (evidence.hierarchy ?? 'unknown') : 'satisfied';
}

function unknownDecision(
  reason: string,
  hierarchy: HierarchyEvidenceStatus = 'unknown',
): RuntimeAccessDecision {
  return { status: 'unknown', reason, missingPermissions: [], missingIntents: [], hierarchy };
}

export function runtimeAccessRequirement(
  toolName: string,
  colocated?: DiscordAccessRequirement,
): DiscordAccessRequirement | null {
  return colocated ?? getToolAccessRequirement(toolName).requirement;
}

export function runtimeAccessRequirementForArgs(
  toolName: string,
  args: unknown,
  colocated?: DiscordAccessRequirement,
): DiscordAccessRequirement | null {
  return resolveToolAccessRequirement(toolName, args, colocated);
}
