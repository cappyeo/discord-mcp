import { DiscordAPIError, HTTPError, RateLimitError, type REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { Routes } from 'discord-api-types/v10';
import { z } from 'zod';
import { BulkheadFullError, CircuitOpenError } from '../../errors/server.js';
import { defineTool } from '../_lib/defineTool.js';
import { dualResult } from '../_lib/response.js';
import { wrapUntrusted } from '../_lib/untrusted.js';
import { type RawGuildTemplate, TemplateBlueprintSchema, TemplateCode } from './_lib/template.js';
import { TEMPLATE_CAPABILITIES, templateRecommendationEvidence } from './_lib/template-evidence.js';
import { getBundledTemplateCatalog } from './catalog/bundled.js';
import {
  type MetadataCandidate,
  RECOMMENDATION_CAPABILITIES,
  type RecommendationCapability,
  retrieveMetadataCandidates,
  type SelectedCandidate,
  selectTemplatePortfolio,
  type TemplateLiveEvidence,
} from './catalog/recommendation.js';

const METADATA_CANDIDATE_LIMIT = 24;
const LIVE_INSPECTION_LIMIT = 8;
const LIVE_CONCURRENCY = 2;
const LIVE_CACHE_TTL_MS = 5 * 60_000;
const LIVE_CACHE_MAX_ENTRIES = 256;

const RecommendationCapabilitySchema = z.enum(RECOMMENDATION_CAPABILITIES);
const RecommendationStatusSchema = z.enum(['ready', 'partial', 'no_match']);
const StructuralDimensionSchema = z.enum([
  'categories',
  'text_channels',
  'voice_channels',
  'forums',
  'stages',
  'custom_roles',
]);

const ScoreBreakdownSchema = z.object({
  intent_fit: z.number().min(0).max(45),
  structural_quality: z.number().min(0).max(30),
  verified_safety: z.number().min(0).max(15),
  metadata_quality: z.number().min(0).max(5),
  usage: z.number().min(0).max(5),
  total: z.number().min(0).max(100),
});

const RecommendationCandidateSchema = z.object({
  code: TemplateCode,
  use_url: z.string().url(),
  score: z.number().min(0).max(100),
  matched_capabilities: z.array(RecommendationCapabilitySchema),
  effective_capabilities: z.array(RecommendationCapabilitySchema),
  contributes: z.array(RecommendationCapabilitySchema),
  structural_contributions: z.array(StructuralDimensionSchema),
  reasons: z.array(z.string()),
  blueprint: TemplateBlueprintSchema,
  quality: z.object({
    verified: z.literal(true),
    code_match: z.literal(true),
    marked_dirty: z.boolean().nullable(),
    confidence: z.enum(['high', 'medium']),
    permission_handling: z.literal('discarded_and_regenerated'),
    risky_permission_signals: z.array(z.string()),
  }),
  score_breakdown: ScoreBreakdownSchema,
});

const VerificationSchema = z.object({
  catalog_records: z.number().int().nonnegative(),
  metadata_candidates: z.number().int().min(0).max(METADATA_CANDIDATE_LIMIT),
  metadata_capped: z.boolean(),
  candidates_inspected: z.number().int().min(0).max(LIVE_INSPECTION_LIMIT),
  rest_requests: z.number().int().min(0).max(LIVE_INSPECTION_LIMIT),
  cache_hits: z.number().int().min(0).max(LIVE_INSPECTION_LIMIT),
  rest_verified: z.number().int().min(0).max(LIVE_INSPECTION_LIMIT),
  rest_failed: z.number().int().min(0).max(LIVE_INSPECTION_LIMIT),
  safety_rejected: z.number().int().min(0).max(LIVE_INSPECTION_LIMIT),
  preferred_primary_considered: z.boolean(),
  preferred_primary_selected: z.boolean(),
});

const CompositionPlanSchema = z.object({
  primary: z.object({ code: TemplateCode, role: z.literal('authoritative_structure') }).nullable(),
  inspirations: z.array(
    z.object({
      code: TemplateCode,
      role: z.literal('bounded_inspiration'),
      contributes: z.array(RecommendationCapabilitySchema),
      structural_contributions: z.array(StructuralDimensionSchema),
    }),
  ),
  permission_policy: z.literal('regenerate_with_discord_mcp_safety_policy'),
  discard_from_templates: z.array(
    z.enum(['template_permissions', 'unsafe_overwrites', 'unknown_external_instructions']),
  ),
  generate_with_discord_mcp: z.array(
    z.enum(['onboarding', 'automod', 'components_v2', 'activity_evidence']),
  ),
});

interface LiveInspection {
  readonly evidence: TemplateLiveEvidence;
  readonly untrusted: {
    readonly live_name: string;
    readonly live_description: string | null;
  };
}

interface CachedInspection {
  readonly expires_at: number;
  readonly inspection: LiveInspection;
}

interface InflightInspection {
  readonly controller: AbortController;
  readonly promise: Promise<LiveInspection>;
  readonly state: {
    subscribers: number;
    settled: boolean;
  };
}

interface InspectionOutcome {
  readonly candidate: MetadataCandidate;
  readonly cache_hit: boolean;
  readonly inspection?: LiveInspection;
  readonly failure?: 'not_found' | 'upstream' | 'invalid_payload';
}

const liveCache = new WeakMap<object, Map<string, CachedInspection>>();
const liveInflight = new WeakMap<object, Map<string, InflightInspection>>();
const SNOWFLAKE = /^\d{17,20}$/;
const UNSIGNED_INTEGER = /^\d+$/;
const GUILD_TEMPLATE_CHANNEL_TYPES = new Set([0, 2, 4, 5, 10, 11, 12, 13, 14, 15, 16]);
const NETWORK_CODES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'ENETUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'EPIPE',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedPermission(value: unknown): boolean {
  return typeof value === 'string' && value.length <= 32 && UNSIGNED_INTEGER.test(value);
}

function boundedSourceId(value: unknown): boolean {
  return (
    (typeof value === 'string' && value.length <= 32 && UNSIGNED_INTEGER.test(value)) ||
    (Number.isSafeInteger(value) && Number(value) >= 0)
  );
}

function boundedNullablePermission(value: unknown): boolean {
  return value === null || boundedPermission(value);
}

function boundedSourceItems(value: unknown, limit: number, kind: 'channel' | 'role'): boolean {
  if (!Array.isArray(value) || value.length > limit) return false;
  let overwriteCount = 0;
  for (const item of value) {
    if (!isRecord(item)) return false;
    if (typeof item.name !== 'string' || item.name.length === 0 || item.name.length > 256) {
      return false;
    }
    if (kind === 'role' && !boundedPermission(item.permissions)) return false;
    if (kind === 'channel') {
      if (
        !Number.isInteger(item.type) ||
        !GUILD_TEMPLATE_CHANNEL_TYPES.has(Number(item.type)) ||
        (item.nsfw !== undefined && typeof item.nsfw !== 'boolean')
      ) {
        return false;
      }
    }
    if (kind === 'channel' && item.permission_overwrites !== undefined) {
      if (!Array.isArray(item.permission_overwrites) || item.permission_overwrites.length > 256) {
        return false;
      }
      for (const overwrite of item.permission_overwrites) {
        if (!isRecord(overwrite)) return false;
        if (!boundedSourceId(overwrite.id)) return false;
        if (overwrite.type !== 0 && overwrite.type !== 1) return false;
        if (
          !Object.hasOwn(overwrite, 'allow') ||
          !boundedNullablePermission(overwrite.allow) ||
          !Object.hasOwn(overwrite, 'deny') ||
          !boundedNullablePermission(overwrite.deny)
        ) {
          return false;
        }
      }
      overwriteCount += item.permission_overwrites.length;
      if (overwriteCount > 2_000) return false;
    }
  }
  return true;
}

function parseRawTemplate(value: unknown): RawGuildTemplate | undefined {
  if (!isRecord(value)) return undefined;
  const source = value.serialized_source_guild;
  if (!isRecord(source)) return undefined;
  if (!boundedSourceItems(source.channels, 500, 'channel')) return undefined;
  if (!boundedSourceItems(source.roles, 250, 'role')) return undefined;
  if (!TemplateCode.safeParse(value.code).success) return undefined;
  if (typeof value.name !== 'string' || value.name.length > 256) return undefined;
  if (
    value.description !== null &&
    (typeof value.description !== 'string' || value.description.length > 4_096)
  ) {
    return undefined;
  }
  if (!Number.isSafeInteger(value.usage_count) || Number(value.usage_count) < 0) return undefined;
  if (typeof value.creator_id !== 'string' || !SNOWFLAKE.test(value.creator_id)) return undefined;
  if (typeof value.source_guild_id !== 'string' || !SNOWFLAKE.test(value.source_guild_id)) {
    return undefined;
  }
  if (typeof value.created_at !== 'string' || typeof value.updated_at !== 'string')
    return undefined;
  if (
    value.is_dirty !== undefined &&
    value.is_dirty !== null &&
    typeof value.is_dirty !== 'boolean'
  ) {
    return undefined;
  }
  return value as unknown as RawGuildTemplate;
}

function liveCapabilities(
  evidence: ReturnType<typeof templateRecommendationEvidence>,
): RecommendationCapability[] {
  const capabilities: RecommendationCapability[] = TEMPLATE_CAPABILITIES.filter(
    (capability) => evidence.capabilities[capability].matched,
  );
  if (evidence.blueprint.voice_channel_count > 0) capabilities.push('voice');
  if (evidence.blueprint.forum_channel_count > 0) capabilities.push('forum');
  return [...new Set(capabilities)];
}

async function inspectLiveTemplate(
  rest: REST,
  candidateCode: string,
  signal: AbortSignal,
): Promise<LiveInspection> {
  const raw = parseRawTemplate(await rest.get(Routes.template(candidateCode), { signal }));
  if (raw === undefined) throw new InvalidTemplatePayloadError();
  const compiled = templateRecommendationEvidence(raw);
  return {
    evidence: {
      code: candidateCode,
      verified: true,
      code_match: raw.code === candidateCode,
      ...(raw.is_dirty === undefined ? {} : { is_dirty: raw.is_dirty }),
      blueprint: compiled.blueprint,
      risky_permission_signals: compiled.blueprint.risky_permission_signals,
      capabilities: liveCapabilities(compiled),
    },
    untrusted: {
      live_name: raw.name.slice(0, 256),
      live_description: raw.description?.slice(0, 512) ?? null,
    },
  };
}

class InvalidTemplatePayloadError extends Error {
  override readonly name = 'InvalidTemplatePayloadError';
}

class InspectionAttemptError extends Error {
  override readonly name = 'InspectionAttemptError';

  constructor(
    readonly original: unknown,
    readonly cache_hit: boolean,
  ) {
    super('Live template inspection failed.');
  }
}

function getInspectionMap<T>(store: WeakMap<object, Map<string, T>>, rest: REST): Map<string, T> {
  let map = store.get(rest);
  if (map === undefined) {
    map = new Map();
    store.set(rest, map);
  }
  return map;
}

function storeCachedInspection(rest: REST, code: string, inspection: LiveInspection): void {
  const cache = getInspectionMap(liveCache, rest);
  const now = Date.now();
  for (const [cachedCode, cached] of cache) {
    if (cached.expires_at <= now) cache.delete(cachedCode);
  }
  cache.delete(code);
  while (cache.size >= LIVE_CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  cache.set(code, { expires_at: now + LIVE_CACHE_TTL_MS, inspection });
}

function createInflightInspection(rest: REST, code: string): InflightInspection {
  const inflight = getInspectionMap(liveInflight, rest);
  const controller = new AbortController();
  const state = { subscribers: 0, settled: false };
  const promise = inspectLiveTemplate(rest, code, controller.signal).then(
    (inspection) => {
      state.settled = true;
      if (inflight.get(code)?.promise === promise) {
        inflight.delete(code);
        if (!controller.signal.aborted) storeCachedInspection(rest, code, inspection);
      }
      return inspection;
    },
    (error: unknown) => {
      state.settled = true;
      if (inflight.get(code)?.promise === promise) inflight.delete(code);
      throw error;
    },
  );
  void promise.catch(() => undefined);
  const entry = { controller, promise, state } satisfies InflightInspection;
  inflight.set(code, entry);
  return entry;
}

async function subscribeToInspection(
  entry: InflightInspection,
  signal: AbortSignal,
): Promise<LiveInspection> {
  signal.throwIfAborted();
  entry.state.subscribers += 1;
  try {
    return await new Promise<LiveInspection>((resolve, reject) => {
      const onAbort = () => reject(signal.reason);
      signal.addEventListener('abort', onAbort, { once: true });
      void entry.promise.then(
        (inspection) => {
          signal.removeEventListener('abort', onAbort);
          resolve(inspection);
        },
        (error: unknown) => {
          signal.removeEventListener('abort', onAbort);
          reject(error);
        },
      );
    });
  } finally {
    entry.state.subscribers -= 1;
    if (entry.state.subscribers === 0 && !entry.state.settled) {
      entry.controller.abort();
    }
  }
}

async function cachedLiveInspection(
  rest: REST,
  code: string,
  signal: AbortSignal,
): Promise<{ readonly inspection: LiveInspection; readonly cache_hit: boolean }> {
  signal.throwIfAborted();
  const cache = getInspectionMap(liveCache, rest);
  const now = Date.now();
  const existing = cache.get(code);
  if (existing !== undefined && existing.expires_at > now) {
    return { inspection: existing.inspection, cache_hit: true };
  }
  if (existing !== undefined) cache.delete(code);

  const inflight = getInspectionMap(liveInflight, rest);
  const shared = inflight.get(code);
  const reusable = shared?.controller.signal.aborted === false ? shared : undefined;
  const cacheHit = reusable !== undefined;
  const entry = reusable ?? createInflightInspection(rest, code);
  try {
    const inspection = await subscribeToInspection(entry, signal);
    signal.throwIfAborted();
    return { inspection, cache_hit: cacheHit };
  } catch (error) {
    signal.throwIfAborted();
    throw new InspectionAttemptError(error, cacheHit);
  }
}

function networkFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as Error & { code?: unknown }).code;
  if (typeof code === 'string' && NETWORK_CODES.has(code)) return true;
  const cause = (error as Error & { cause?: unknown }).cause;
  if (!(cause instanceof Error)) return false;
  const causeCode = (cause as Error & { code?: unknown }).code;
  return typeof causeCode === 'string' && NETWORK_CODES.has(causeCode);
}

function recoverableFailure(error: unknown): InspectionOutcome['failure'] | undefined {
  if (error instanceof InvalidTemplatePayloadError) return 'invalid_payload';
  if (error instanceof RateLimitError || networkFailure(error)) return 'upstream';
  if (error instanceof DiscordAPIError || error instanceof HTTPError) {
    if (error.status === 400) return 'invalid_payload';
    if (error.status === 404) return 'not_found';
    if (error.status === 429 || error.status >= 500) return 'upstream';
  }
  return undefined;
}

async function inspectCandidates(
  rest: REST,
  candidates: readonly MetadataCandidate[],
  signal: AbortSignal,
): Promise<InspectionOutcome[]> {
  const outcomes = new Array<InspectionOutcome>(candidates.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < candidates.length) {
      signal.throwIfAborted();
      const index = cursor;
      cursor += 1;
      const candidate = candidates[index]!;
      const code = candidate.record.code!;
      try {
        const result = await cachedLiveInspection(rest, code, signal);
        outcomes[index] = { candidate, ...result };
      } catch (caught) {
        signal.throwIfAborted();
        const error = caught instanceof InspectionAttemptError ? caught.original : caught;
        const cacheHit = caught instanceof InspectionAttemptError ? caught.cache_hit : false;
        if (error instanceof CircuitOpenError || error instanceof BulkheadFullError) throw error;
        if (
          (error instanceof DiscordAPIError || error instanceof HTTPError) &&
          (error.status === 401 || error.status === 403)
        ) {
          throw error;
        }
        const failure = recoverableFailure(error);
        if (failure === undefined) throw error;
        outcomes[index] = { candidate, cache_hit: cacheHit, failure };
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(LIVE_CONCURRENCY, candidates.length) }, () => worker()),
  );
  return outcomes;
}

type StructuralDimension = z.infer<typeof StructuralDimensionSchema>;

function structuralDimensions(candidate: SelectedCandidate): StructuralDimension[] {
  const blueprint = candidate.evidence?.blueprint;
  if (blueprint === undefined) return [];
  return [
    ...(Number(blueprint.category_count ?? 0) > 0 ? (['categories'] as const) : []),
    ...(Number(blueprint.text_channel_count ?? 0) > 0 ? (['text_channels'] as const) : []),
    ...(Number(blueprint.voice_channel_count ?? 0) > 0 ? (['voice_channels'] as const) : []),
    ...(Number(blueprint.forum_channel_count ?? 0) > 0 ? (['forums'] as const) : []),
    ...(Number(blueprint.stage_channel_count ?? 0) > 0 ? (['stages'] as const) : []),
    ...(Number(blueprint.role_count ?? 0) > 1 ? (['custom_roles'] as const) : []),
  ];
}

function candidateOutput(
  candidate: SelectedCandidate,
  contributes: readonly RecommendationCapability[],
  structuralContributions: readonly StructuralDimension[],
) {
  const code = candidate.record.code;
  const blueprint = candidate.evidence?.blueprint;
  if (code === null || blueprint === undefined) {
    throw new Error('Selected template is missing verified structural evidence.');
  }
  return {
    code,
    use_url: `https://discord.new/${encodeURIComponent(code)}`,
    score: candidate.portfolio_score_breakdown.total,
    matched_capabilities: [...candidate.matched_capabilities],
    effective_capabilities: [...candidate.effective_capabilities],
    contributes: [...contributes],
    structural_contributions: [...structuralContributions],
    reasons: [...candidate.reasons],
    blueprint,
    quality: {
      verified: true as const,
      code_match: true as const,
      marked_dirty: candidate.evidence?.is_dirty ?? null,
      confidence: candidate.evidence?.is_dirty === false ? ('high' as const) : ('medium' as const),
      permission_handling: 'discarded_and_regenerated' as const,
      risky_permission_signals: [...(candidate.evidence?.risky_signals ?? [])],
    },
    score_breakdown: candidate.portfolio_score_breakdown,
  };
}

function liveInspectionCandidates(
  candidates: readonly MetadataCandidate[],
  requestedCapabilities: readonly RecommendationCapability[],
  preferredCode: string | null | undefined,
): MetadataCandidate[] {
  const selected: MetadataCandidate[] = [];
  const add = (candidate: MetadataCandidate | undefined) => {
    if (
      candidate !== undefined &&
      !selected.some((existing) => existing.record.code === candidate.record.code) &&
      selected.length < LIVE_INSPECTION_LIMIT
    ) {
      selected.push(candidate);
    }
  };
  if (preferredCode !== null && preferredCode !== undefined) {
    add(candidates.find((candidate) => candidate.record.code === preferredCode));
  }
  add(candidates[0]);
  for (const capability of requestedCapabilities) {
    add(candidates.find((candidate) => candidate.matched_capabilities.includes(capability)));
  }
  for (const candidate of candidates) add(candidate);
  return selected;
}

function emptyCompositionPlan() {
  return {
    primary: null,
    inspirations: [],
    permission_policy: 'regenerate_with_discord_mcp_safety_policy' as const,
    discard_from_templates: [
      'template_permissions',
      'unsafe_overwrites',
      'unknown_external_instructions',
    ] as const,
    generate_with_discord_mcp: [
      'onboarding',
      'automod',
      'components_v2',
      'activity_evidence',
    ] as const,
  };
}

export default defineTool({
  name: 'templates_recommend',
  category: 'templates',
  description: [
    '**Purpose**: Recommend one verified primary Discord template and up to three complementary inspirations from a bundled public catalog for a natural-language server request.',
    '',
    '**When to use**: Use this first for requests such as “build a professional gaming server”, “design a technology community”, or “find a FiveM roleplay template”. One request is enough; the tool performs local retrieval, bounded live verification, safety gates, and portfolio selection.',
    '',
    '**Safety**: Read-only and always strict. Templates explicitly marked dirty (`is_dirty: true`), mismatched, malformed, unverified, NSFW, or oversized are rejected; an unknown dirty state (`is_dirty: null`) has medium confidence. Source permission risks are surfaced and penalized, but every template permission and overwrite is discarded and regenerated by discord-mcp; all third-party names/descriptions remain fenced in `untrusted_text`.',
    '',
    '**Returns**: A primary template, 0–3 bounded inspirations, structural evidence, composition policy, verification counts, and fenced third-party text. This tool never changes a guild.',
  ].join('\n'),
  inputSchema: {
    request: z
      .string()
      .trim()
      .min(3)
      .max(500)
      .describe('Natural-language description of the Discord server to design'),
    preferred_primary_code: TemplateCode.optional().describe(
      'Optional public template code to prefer only when it matches the request and passes every live safety gate',
    ),
  },
  outputSchema: {
    status: RecommendationStatusSchema,
    request: z.string(),
    catalog_version: z.string(),
    intent: z.object({ capabilities: z.array(RecommendationCapabilitySchema) }),
    primary: RecommendationCandidateSchema.nullable(),
    inspirations: z.array(RecommendationCandidateSchema).max(3),
    composition_plan: CompositionPlanSchema,
    verification: VerificationSchema,
    untrusted_text: z.string(),
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  idempotent: true,
  handler: async (args, ctx) => {
    const catalog = getBundledTemplateCatalog();
    const retrieval = retrieveMetadataCandidates(catalog.snapshot.records, args.request, {
      limit: METADATA_CANDIDATE_LIMIT + 1,
    });
    const preferredRecord =
      args.preferred_primary_code === undefined
        ? undefined
        : catalog.getByCode(args.preferred_primary_code);
    const preferredRetrieval =
      preferredRecord === undefined
        ? undefined
        : retrieveMetadataCandidates([preferredRecord], args.request, { limit: 1 });
    const preferredCandidate = preferredRetrieval?.candidates[0];
    let metadataCandidates = retrieval.candidates.slice(0, METADATA_CANDIDATE_LIMIT);
    if (
      preferredCandidate !== undefined &&
      !metadataCandidates.some(
        (candidate) => candidate.record.code === preferredCandidate.record.code,
      )
    ) {
      metadataCandidates = [preferredCandidate, ...metadataCandidates].slice(
        0,
        METADATA_CANDIDATE_LIMIT,
      );
    }
    const baseVerification = {
      catalog_records: catalog.snapshot.counts.total,
      metadata_candidates: metadataCandidates.length,
      metadata_capped: retrieval.candidates.length > METADATA_CANDIDATE_LIMIT,
      preferred_primary_considered: preferredCandidate !== undefined,
    };
    if (metadataCandidates.length === 0) {
      return dualResult({
        text: 'No catalog template met the minimum relevance threshold. No Discord REST request was made and no guild was changed.',
        data: {
          status: 'no_match' as const,
          request: args.request,
          catalog_version: catalog.snapshot.version,
          intent: { capabilities: [...retrieval.requested_capabilities] },
          primary: null,
          inspirations: [],
          composition_plan: emptyCompositionPlan(),
          verification: {
            ...baseVerification,
            candidates_inspected: 0,
            rest_requests: 0,
            cache_hits: 0,
            rest_verified: 0,
            rest_failed: 0,
            safety_rejected: 0,
            preferred_primary_selected: false,
          },
          untrusted_text: wrapUntrusted('[]', 'template'),
        },
      });
    }

    const preferredCode = preferredCandidate?.record.code;
    const inspectionCandidates = liveInspectionCandidates(
      metadataCandidates,
      retrieval.requested_capabilities,
      preferredCode,
    );
    const outcomes = await inspectCandidates(container.rest, inspectionCandidates, ctx.signal);
    const evidence = outcomes.flatMap((outcome) =>
      outcome.inspection === undefined ? [] : [outcome.inspection.evidence],
    );
    const portfolio = selectTemplatePortfolio(inspectionCandidates, evidence, {
      ...(preferredCode === null || preferredCode === undefined
        ? {}
        : { preferred_primary_code: preferredCode }),
      requested_capabilities: retrieval.requested_capabilities,
    });
    const selectedPrimary = portfolio.primary;
    const primaryCapabilities =
      selectedPrimary === null
        ? []
        : selectedPrimary.effective_capabilities.filter((capability) =>
            retrieval.requested_capabilities.includes(capability),
          );
    const coveredCapabilities = new Set(primaryCapabilities);
    const coveredDimensions = new Set(
      selectedPrimary === null ? [] : structuralDimensions(selectedPrimary),
    );
    const inspirationOutputs = portfolio.inspirations.map((candidate) => {
      const contributes = candidate.effective_capabilities.filter(
        (capability) =>
          retrieval.requested_capabilities.includes(capability) &&
          !coveredCapabilities.has(capability),
      );
      for (const capability of contributes) coveredCapabilities.add(capability);
      const dimensions = structuralDimensions(candidate).filter(
        (dimension) => !coveredDimensions.has(dimension),
      );
      for (const dimension of dimensions) coveredDimensions.add(dimension);
      return candidateOutput(candidate, contributes, dimensions);
    });
    const primaryOutput =
      selectedPrimary === null
        ? null
        : candidateOutput(
            selectedPrimary,
            primaryCapabilities,
            structuralDimensions(selectedPrimary),
          );
    const failed = outcomes.filter((outcome) => outcome.inspection === undefined).length;
    const status =
      primaryOutput !== null
        ? ('ready' as const)
        : failed > 0
          ? ('partial' as const)
          : ('no_match' as const);
    const selectedCodes = new Set([
      ...(primaryOutput === null ? [] : [primaryOutput.code]),
      ...inspirationOutputs.map((candidate) => candidate.code),
    ]);
    const untrustedRecords = outcomes.flatMap((outcome) => {
      const code = outcome.candidate.record.code;
      if (code === null || !selectedCodes.has(code) || outcome.inspection === undefined) return [];
      return [
        {
          code,
          catalog_name: outcome.candidate.record.name,
          catalog_description: outcome.candidate.record.description?.slice(0, 512) ?? null,
          ...outcome.inspection.untrusted,
        },
      ];
    });
    const compositionPlan = {
      ...emptyCompositionPlan(),
      primary:
        primaryOutput === null
          ? null
          : { code: primaryOutput.code, role: 'authoritative_structure' as const },
      inspirations: inspirationOutputs.map((candidate) => ({
        code: candidate.code,
        role: 'bounded_inspiration' as const,
        contributes: candidate.contributes,
        structural_contributions: candidate.structural_contributions,
      })),
    };
    return dualResult({
      text:
        primaryOutput === null
          ? `Template recommendation is ${status}: ${outcomes.length} candidate(s) were inspected, but none produced a complete safe primary. No guild was changed.`
          : `Recommended verified primary template \`${primaryOutput.code}\` with ${inspirationOutputs.length} bounded inspiration template(s). Permissions must be regenerated by discord-mcp; no guild was changed.`,
      data: {
        status,
        request: args.request,
        catalog_version: catalog.snapshot.version,
        intent: { capabilities: [...retrieval.requested_capabilities] },
        primary: primaryOutput,
        inspirations: inspirationOutputs,
        composition_plan: compositionPlan,
        verification: {
          ...baseVerification,
          candidates_inspected: outcomes.length,
          rest_requests: outcomes.filter((outcome) => !outcome.cache_hit).length,
          cache_hits: outcomes.filter((outcome) => outcome.cache_hit).length,
          rest_verified: outcomes.filter(
            (outcome) =>
              outcome.inspection?.evidence.verified === true &&
              outcome.inspection.evidence.code_match,
          ).length,
          rest_failed: failed,
          safety_rejected: portfolio.rejected.length - failed,
          preferred_primary_selected:
            preferredCode !== null &&
            preferredCode !== undefined &&
            primaryOutput?.code === preferredCode,
        },
        untrusted_text: wrapUntrusted(JSON.stringify(untrustedRecords), 'template'),
      },
    });
  },
});
