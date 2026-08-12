import type { TemplateProvenance } from '../_lib/provenance.js';
import type { CatalogRecord } from './index.js';

/** The small, stable capability vocabulary used by metadata retrieval. */
export type RecommendationCapability =
  | 'gaming'
  | 'community'
  | 'roleplay'
  | 'lfg'
  | 'platform'
  | 'staff'
  | 'support'
  | 'events'
  | 'technology'
  | 'learning'
  | 'art'
  | 'music'
  | 'voice'
  | 'forum';

export type RecommendationStatus = 'ready' | 'no_match';

export interface RecommendationScoreBreakdown {
  readonly intent_fit: number;
  readonly lexical_match: number;
  readonly metadata_quality: number;
  readonly usage: number;
  readonly total: number;
}

export interface MetadataCandidate {
  readonly record: CatalogRecord;
  readonly score: number;
  readonly score_breakdown: RecommendationScoreBreakdown;
  readonly matched_capabilities: readonly RecommendationCapability[];
  /** 1 = name/description evidence, 0.55 = tag-only evidence. */
  readonly capability_scores: Readonly<Partial<Record<RecommendationCapability, number>>>;
  readonly reasons: readonly string[];
}

export interface MetadataRetrievalResult {
  readonly status: RecommendationStatus;
  readonly requested_capabilities: readonly RecommendationCapability[];
  readonly candidates: readonly MetadataCandidate[];
  readonly reasons?: readonly string[];
}

export interface TemplateBlueprintCounts {
  readonly channel_count?: number;
  readonly category_count?: number;
  readonly text_channel_count?: number;
  readonly voice_channel_count?: number;
  readonly forum_channel_count?: number;
  readonly stage_channel_count?: number;
  readonly other_channel_count?: number;
  readonly nsfw_channel_count?: number;
  readonly permission_overwrite_count?: number;
  readonly role_count?: number;
  readonly privileged_role_count?: number;
  readonly risky_permission_signals?: readonly RiskyPermissionSignal[];
}

export interface RiskyPermissionSignal {
  readonly permission: string;
  readonly role_count?: number;
}

/** Live data is deliberately a narrow injected seam; this module never calls Discord. */
export interface TemplateLiveEvidence {
  readonly code: string;
  readonly verified: boolean;
  readonly code_match: boolean;
  readonly is_dirty?: boolean | null;
  readonly blueprint?: TemplateBlueprintCounts;
  readonly risky_permission_signals?: readonly (RiskyPermissionSignal | string)[];
  /** Alias accepted for callers that flatten blueprint risk signals. */
  readonly risky_signals?: readonly string[];
  /** Optional capabilities derived by a trusted live blueprint inspector. */
  readonly capabilities?: readonly RecommendationCapability[];
  /** Audit binding for the live payload used to derive this evidence. */
  readonly provenance?: TemplateProvenance;
}

export interface LiveEvidenceSummary {
  readonly verified: boolean;
  readonly code_match: boolean;
  readonly is_dirty: boolean | null | undefined;
  readonly blueprint?: TemplateBlueprintCounts;
  readonly risky_signals: readonly string[];
  readonly provenance?: TemplateProvenance;
}

export interface PortfolioScoreBreakdown {
  readonly intent_fit: number;
  readonly structural_quality: number;
  readonly verified_safety: number;
  readonly metadata_quality: number;
  readonly usage: number;
  readonly total: number;
}

export interface SelectedCandidate extends MetadataCandidate {
  readonly evidence?: LiveEvidenceSummary;
  readonly effective_capabilities: readonly RecommendationCapability[];
  readonly portfolio_score_breakdown: PortfolioScoreBreakdown;
}

export interface RejectedCandidate {
  readonly code: string;
  readonly reasons: readonly string[];
  readonly provenance?: TemplateProvenance;
}

export interface TemplatePortfolio {
  readonly status: RecommendationStatus;
  readonly primary: SelectedCandidate | null;
  readonly inspirations: readonly SelectedCandidate[];
  readonly rejected: readonly RejectedCandidate[];
  readonly reasons: readonly string[];
}

export interface MetadataRetrievalOptions {
  readonly limit?: number;
}

export interface PortfolioSelectionOptions {
  readonly preferred_primary_code?: string;
  readonly requested_capabilities?: readonly RecommendationCapability[];
}

export const RECOMMENDATION_CAPABILITIES = [
  'gaming',
  'community',
  'roleplay',
  'lfg',
  'platform',
  'staff',
  'support',
  'events',
  'technology',
  'learning',
  'art',
  'music',
  'voice',
  'forum',
] as const satisfies readonly RecommendationCapability[];

const CAPABILITY_ALIASES: Readonly<Record<RecommendationCapability, readonly string[]>> = {
  gaming: [
    'gaming',
    'game',
    'games',
    'gamer',
    'gamers',
    'choi game',
    'tro choi',
    'video game',
    'esport',
    'esports',
    'fivem',
    'roblox',
    'minecraft',
    'fortnite',
  ],
  community: ['community', 'cong dong', 'communities'],
  roleplay: ['roleplay', 'role play', 'nhap vai', 'rp'],
  lfg: [
    'lfg',
    'looking for group',
    'tim dong doi',
    'tim team',
    'tim nguoi choi',
    'squad',
    'teammate',
    'team up',
  ],
  platform: ['platform', 'nen tang', 'pc', 'mobile', 'console', 'playstation', 'xbox', 'switch'],
  staff: ['staff', 'moderation', 'moderator', 'moderators', 'quan tri', 'admin', 'administrator'],
  support: ['support', 'help', 'tro giup', 'ticket', 'tickets', 'troubleshooting'],
  events: ['event', 'events', 'su kien', 'tournament', 'tournaments', 'giai dau', 'contest'],
  technology: [
    'technology',
    'tech',
    'cong nghe',
    'coding',
    'code',
    'developer',
    'developers',
    'programming',
    'software',
    'open source',
    'opensource',
    'artificial intelligence',
  ],
  learning: ['learning', 'learn', 'hoc tap', 'education', 'study', 'course', 'courses'],
  art: ['art', 'nghe thuat', 'design', 'drawing', 'artist', 'artists'],
  music: ['music', 'nhac', 'song', 'spotify', 'musician', 'musicians'],
  voice: ['voice', 'thoai', 'voice chat', 'call', 'vc'],
  forum: ['forum', 'dien dan', 'discussion', 'discussions'],
};

const STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'cho',
  'co',
  'cua',
  'for',
  'in',
  'la',
  'mot',
  'no',
  'of',
  'server',
  'such',
  'the',
  'to',
  'va',
  'voi',
  'where',
]);

/** Normalize Vietnamese and English user text without changing the catalog. */
export function normalizeRecommendationText(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[đĐ]/g, 'd')
    .replace(/\p{Diacritic}/gu, '')
    .toLocaleLowerCase('en-US')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function tokens(value: string): readonly string[] {
  const normalized = normalizeRecommendationText(value);
  return normalized.length === 0 ? [] : normalized.split(/\s+/u);
}

interface CapabilityMatcher {
  readonly single_tokens: ReadonlySet<string>;
  readonly phrases: readonly (readonly string[])[];
}

function buildCapabilityMatchers(): Readonly<Record<RecommendationCapability, CapabilityMatcher>> {
  const matchers = {} as Record<RecommendationCapability, CapabilityMatcher>;
  for (const capability of RECOMMENDATION_CAPABILITIES) {
    const singleTokens = new Set<string>();
    const phrases: string[][] = [];
    for (const alias of CAPABILITY_ALIASES[capability]) {
      const aliasTokens = tokens(alias);
      if (aliasTokens.length === 1) singleTokens.add(aliasTokens[0]!);
      else if (aliasTokens.length > 1) phrases.push([...aliasTokens]);
    }
    matchers[capability] = { single_tokens: singleTokens, phrases };
  }
  return matchers;
}

const CAPABILITY_MATCHERS = buildCapabilityMatchers();

function containsPhrase(textTokens: readonly string[], phrase: readonly string[]): boolean {
  if (phrase.length === 0 || phrase.length > textTokens.length) return false;
  for (let start = 0; start <= textTokens.length - phrase.length; start += 1) {
    if (phrase.every((token, offset) => textTokens[start + offset] === token)) return true;
  }
  return false;
}

function capabilitiesInNormalizedText(normalizedText: string): RecommendationCapability[] {
  const textTokens = normalizedText.length === 0 ? [] : normalizedText.split(/\s+/u);
  const tokenSet = new Set(textTokens);
  return RECOMMENDATION_CAPABILITIES.filter((capability) => {
    const matcher = CAPABILITY_MATCHERS[capability];
    return (
      [...matcher.single_tokens].some((token) => tokenSet.has(token)) ||
      matcher.phrases.some((phrase) => containsPhrase(textTokens, phrase))
    );
  });
}

function capabilitiesInText(text: string): RecommendationCapability[] {
  return capabilitiesInNormalizedText(normalizeRecommendationText(text));
}

interface IndexedRecordText {
  readonly all: string;
  readonly name: string;
  readonly description: string;
  readonly tags: string;
  readonly name_tokens: ReadonlySet<string>;
  readonly description_tokens: ReadonlySet<string>;
  readonly tag_tokens: ReadonlySet<string>;
  readonly strong_capabilities: readonly RecommendationCapability[];
  readonly tag_capabilities: readonly RecommendationCapability[];
}

const RECORD_TEXT_CACHE = new WeakMap<CatalogRecord, IndexedRecordText>();

function recordText(record: CatalogRecord): IndexedRecordText {
  const cached = RECORD_TEXT_CACHE.get(record);
  if (cached !== undefined) return cached;
  const name = normalizeRecommendationText(record.name);
  const description = normalizeRecommendationText(record.description ?? '');
  const tags = normalizeRecommendationText(record.tags.join(' '));
  const indexed = {
    name,
    description,
    tags,
    all: `${name} ${description} ${tags}`.trim(),
    name_tokens: new Set(tokens(name)),
    description_tokens: new Set(tokens(description)),
    tag_tokens: new Set(tokens(tags)),
    strong_capabilities: capabilitiesInNormalizedText(`${name} ${description}`.trim()),
    tag_capabilities: capabilitiesInNormalizedText(tags),
  } satisfies IndexedRecordText;
  RECORD_TEXT_CACHE.set(record, indexed);
  return indexed;
}

function lexicalScore(requestTokens: readonly string[], text: IndexedRecordText): number {
  const useful = requestTokens.filter((token) => !STOP_WORDS.has(token));
  if (useful.length === 0) return 0;
  let points = 0;
  for (const token of new Set(useful)) {
    if (text.name_tokens.has(token)) points += 3;
    else if (text.tag_tokens.has(token)) points += 2;
    else if (text.description_tokens.has(token)) points += 1;
  }
  const overlap = points / Math.max(1, useful.length * 3);
  const exactNameTokens = tokens(text.name);
  const exactName =
    exactNameTokens.length > 0 &&
    exactNameTokens.length <= requestTokens.length &&
    requestTokens.some((_, start) =>
      exactNameTokens.every((token, offset) => requestTokens[start + offset] === token),
    );
  return Math.min(20, Math.round((overlap * 15 + (exactName ? 5 : 0)) * 100) / 100);
}

function usageScore(value: number): number {
  // A capped log prior keeps popularity useful for ties, never for intent.
  return Math.min(5, Math.round((Math.log10(value + 1) / 5) * 100) / 100);
}

function metadataQuality(record: CatalogRecord): number {
  return (record.name.trim().length > 0 ? 2 : 0) + (record.description?.trim() ? 3 : 0);
}

function compareCandidates(left: MetadataCandidate, right: MetadataCandidate): number {
  if (right.score !== left.score) return right.score - left.score;
  if (right.score_breakdown.intent_fit !== left.score_breakdown.intent_fit) {
    return right.score_breakdown.intent_fit - left.score_breakdown.intent_fit;
  }
  return (left.record.code ?? '').localeCompare(right.record.code ?? '');
}

/** Retrieve ranked metadata candidates. This function is deterministic and performs no I/O. */
export function retrieveMetadataCandidates(
  records: readonly CatalogRecord[],
  request: string,
  options: MetadataRetrievalOptions = {},
): MetadataRetrievalResult {
  const requested = capabilitiesInText(request);
  const requestTokens = tokens(request);
  const candidates: MetadataCandidate[] = [];
  for (const record of records) {
    if (record.availability !== 'active' || record.code === null) continue;
    const text = recordText(record);
    const capabilityScores: Partial<Record<RecommendationCapability, number>> = {};
    for (const capability of requested) {
      if (text.strong_capabilities.includes(capability)) capabilityScores[capability] = 1;
      else if (text.tag_capabilities.includes(capability)) capabilityScores[capability] = 0.55;
    }
    const matched = requested.filter((capability) => capabilityScores[capability] !== undefined);
    const lexical = lexicalScore(requestTokens, text);
    if (requested.length > 0 ? matched.length === 0 : lexical < 8) continue;
    const intentFit =
      requested.length === 0
        ? 0
        : Math.round(
            (matched.reduce((sum, capability) => sum + (capabilityScores[capability] ?? 0), 0) /
              requested.length) *
              70 *
              100,
          ) / 100;
    const quality = metadataQuality(record);
    const usage = usageScore(record.usage_count);
    const total = Math.round((intentFit + lexical + quality + usage) * 100) / 100;
    const reasons = [
      matched.length > 0
        ? `Matches capabilities: ${matched.join(', ')}.`
        : 'Selected from lexical metadata overlap.',
      record.description === null
        ? 'Catalog description is missing.'
        : 'Catalog description is present.',
    ];
    candidates.push({
      record,
      score: total,
      score_breakdown: {
        intent_fit: intentFit,
        lexical_match: lexical,
        metadata_quality: quality,
        usage,
        total,
      },
      matched_capabilities: matched,
      capability_scores: capabilityScores,
      reasons,
    });
  }
  candidates.sort(compareCandidates);
  const limit =
    options.limit === undefined ? candidates.length : Math.max(0, Math.floor(options.limit));
  const limited = candidates.slice(0, limit);
  if (limited.length === 0) {
    return {
      status: 'no_match',
      requested_capabilities: requested,
      candidates: [],
      reasons:
        requested.length === 0
          ? ['No recognized capability or catalog lexical match.']
          : ['No active catalog record matches the requested capabilities.'],
    };
  }
  return { status: 'ready', requested_capabilities: requested, candidates: limited };
}

function evidenceMap(
  evidence: readonly TemplateLiveEvidence[] | ReadonlyMap<string, TemplateLiveEvidence>,
): ReadonlyMap<string, TemplateLiveEvidence> {
  return Array.isArray(evidence)
    ? new Map<string, TemplateLiveEvidence>(evidence.map((item) => [item.code, item]))
    : (evidence as ReadonlyMap<string, TemplateLiveEvidence>);
}

function riskNames(evidence: TemplateLiveEvidence): readonly string[] {
  const names = [
    ...(evidence.risky_signals ?? []),
    ...(evidence.risky_permission_signals ?? []).map((signal) =>
      typeof signal === 'string' ? signal : signal.permission,
    ),
    ...(evidence.blueprint?.risky_permission_signals ?? []).map((signal) => signal.permission),
  ];
  return [...new Set(names.map((name) => name.toUpperCase()))].sort();
}

function summary(evidence: TemplateLiveEvidence): LiveEvidenceSummary {
  return {
    verified: evidence.verified,
    code_match: evidence.code_match,
    is_dirty: evidence.is_dirty,
    ...(evidence.blueprint === undefined ? {} : { blueprint: evidence.blueprint }),
    risky_signals: riskNames(evidence),
    ...(evidence.provenance === undefined ? {} : { provenance: evidence.provenance }),
  };
}

function minimumViable(blueprint: TemplateBlueprintCounts | undefined): boolean {
  if (blueprint === undefined) return false;
  return (
    (blueprint.channel_count ?? 0) >= 3 &&
    (blueprint.channel_count ?? 0) <= 96 &&
    (blueprint.text_channel_count ?? 0) >= 1 &&
    (blueprint.role_count ?? 0) >= 2 &&
    (blueprint.role_count ?? 0) <= 64 &&
    (blueprint.permission_overwrite_count ?? 0) <= 500
  );
}

function structuralQuality(blueprint: TemplateBlueprintCounts | undefined): number {
  if (blueprint === undefined) return 0;
  const channels = blueprint.channel_count ?? 0;
  const categories = blueprint.category_count ?? 0;
  const roles = blueprint.role_count ?? 0;
  const channelScore =
    channels >= 12 && channels <= 48 ? 8 : channels >= 6 && channels <= 64 ? 6 : 2;
  const categoryScore =
    categories >= 2 && categories <= 10 ? 6 : categories >= 1 && categories <= 16 ? 4 : 0;
  const textVoiceScore =
    (blueprint.text_channel_count ?? 0) > 0 && (blueprint.voice_channel_count ?? 0) > 0 ? 6 : 2;
  const roleScore = roles >= 4 && roles <= 24 ? 5 : roles >= 2 && roles <= 32 ? 3 : 0;
  const specializedScore =
    ((blueprint.forum_channel_count ?? 0) > 0 ? 2 : 0) +
    ((blueprint.stage_channel_count ?? 0) > 0 ? 1 : 0);
  const overwriteScore = (blueprint.permission_overwrite_count ?? 0) > 0 ? 2 : 0;
  const nsfwPenalty = Math.min(6, (blueprint.nsfw_channel_count ?? 0) * 2);
  return Math.max(
    0,
    Math.min(
      30,
      channelScore +
        categoryScore +
        textVoiceScore +
        roleScore +
        specializedScore +
        overwriteScore -
        nsfwPenalty,
    ),
  );
}

function portfolioScore(
  candidate: MetadataCandidate,
  evidence: TemplateLiveEvidence | undefined,
  requestedCapabilities: readonly RecommendationCapability[],
): PortfolioScoreBreakdown {
  const liveCapabilities = new Set(evidence?.capabilities ?? []);
  const intentFit =
    requestedCapabilities.length === 0
      ? Math.round((candidate.score_breakdown.lexical_match / 20) * 45 * 100) / 100
      : Math.round(
          (requestedCapabilities.reduce(
            (sum, capability) =>
              sum +
              (liveCapabilities.has(capability)
                ? 1
                : (candidate.capability_scores[capability] ?? 0)),
            0,
          ) /
            requestedCapabilities.length) *
            45 *
            100,
        ) / 100;
  const structural = structuralQuality(evidence?.blueprint);
  const risks = riskNames(evidence ?? { code: '', verified: false, code_match: false });
  const verifiedSafety =
    evidence?.verified &&
    evidence.code_match &&
    evidence.is_dirty !== true &&
    (evidence.blueprint?.nsfw_channel_count ?? 0) === 0
      ? Math.max(0, 15 - (evidence.is_dirty === false ? 0 : 2) - Math.min(8, risks.length))
      : 0;
  const metadata = candidate.score_breakdown.metadata_quality;
  const usage = candidate.score_breakdown.usage;
  const total =
    Math.round((intentFit + structural + verifiedSafety + metadata + usage) * 100) / 100;
  return {
    intent_fit: intentFit,
    structural_quality: structural,
    verified_safety: verifiedSafety,
    metadata_quality: metadata,
    usage,
    total,
  };
}

function comparePortfolioCandidates(left: SelectedCandidate, right: SelectedCandidate): number {
  if (right.portfolio_score_breakdown.total !== left.portfolio_score_breakdown.total) {
    return right.portfolio_score_breakdown.total - left.portfolio_score_breakdown.total;
  }
  if (right.portfolio_score_breakdown.intent_fit !== left.portfolio_score_breakdown.intent_fit) {
    return right.portfolio_score_breakdown.intent_fit - left.portfolio_score_breakdown.intent_fit;
  }
  return (left.record.code ?? '').localeCompare(right.record.code ?? '');
}

function gateReasons(evidence: TemplateLiveEvidence | undefined): string[] {
  if (evidence === undefined) return ['Live evidence is unavailable (unverified).'];
  const reasons: string[] = [];
  if (!evidence.verified) reasons.push('Live evidence is unverified.');
  if (!evidence.code_match) reasons.push('Live evidence code does not match the catalog code.');
  if (evidence.is_dirty === true) reasons.push('Template is marked dirty.');
  if ((evidence.blueprint?.nsfw_channel_count ?? 0) > 0)
    reasons.push('Template contains NSFW channels.');
  if (!minimumViable(evidence.blueprint)) reasons.push('Template fails minimum viable structure.');
  return reasons;
}

function gainFor(
  candidate: SelectedCandidate,
  selected: readonly SelectedCandidate[],
  requestedCapabilities: readonly RecommendationCapability[],
): { readonly value: number; readonly capabilities: readonly RecommendationCapability[] } {
  const covered = new Set(selected.flatMap((item) => item.effective_capabilities));
  const newCapabilities = candidate.effective_capabilities.filter(
    (capability) => requestedCapabilities.includes(capability) && !covered.has(capability),
  );
  const baseline = selected.reduce(
    (max, item) => {
      const blueprint = item.evidence?.blueprint;
      if (blueprint === undefined) return max;
      for (const key of STRUCTURAL_KEYS) {
        const value = blueprint[key] ?? 0;
        max[key] = Math.max(max[key] ?? 0, value);
      }
      return max;
    },
    {} as Record<string, number>,
  );
  const blueprint = candidate.evidence?.blueprint;
  let structuralGain = 0;
  if (blueprint !== undefined) {
    for (const key of STRUCTURAL_KEYS) {
      // Presence of a named dimension is meaningful; arbitrary channel/role
      // inflation is deliberately not treated as portfolio diversity.
      if ((baseline[key] ?? 0) === 0 && (blueprint[key] ?? 0) > 0) structuralGain += 4;
    }
  }
  return { value: newCapabilities.length * 10 + structuralGain, capabilities: newCapabilities };
}

const STRUCTURAL_KEYS = [
  'category_count',
  'text_channel_count',
  'voice_channel_count',
  'forum_channel_count',
  'stage_channel_count',
  'role_count',
] as const;

/** Select one primary and an optional, diverse portfolio after live evidence is injected. */
export function selectTemplatePortfolio(
  candidates: readonly MetadataCandidate[],
  liveEvidence: readonly TemplateLiveEvidence[] | ReadonlyMap<string, TemplateLiveEvidence>,
  options: PortfolioSelectionOptions = {},
): TemplatePortfolio {
  const requestedCapabilities = options.requested_capabilities ?? [];
  const byCode = evidenceMap(liveEvidence);
  const rejected: RejectedCandidate[] = [];
  const eligible: SelectedCandidate[] = [];
  for (const candidate of candidates) {
    const code = candidate.record.code;
    if (code === null) continue;
    const itemEvidence = byCode.get(code);
    const reasons = gateReasons(itemEvidence);
    if (reasons.length > 0) {
      rejected.push({
        code,
        reasons,
        ...(itemEvidence?.provenance === undefined ? {} : { provenance: itemEvidence.provenance }),
      });
    } else {
      const effectiveCapabilities = [
        ...new Set([...candidate.matched_capabilities, ...(itemEvidence?.capabilities ?? [])]),
      ];
      eligible.push({
        ...candidate,
        ...(itemEvidence === undefined ? {} : { evidence: summary(itemEvidence) }),
        effective_capabilities: effectiveCapabilities,
        portfolio_score_breakdown: portfolioScore(candidate, itemEvidence, requestedCapabilities),
      });
    }
  }
  if (eligible.length === 0) {
    return {
      status: 'no_match',
      primary: null,
      inspirations: [],
      rejected,
      reasons: ['No candidate passed the portfolio safety gates.'],
    };
  }
  eligible.sort(comparePortfolioCandidates);
  const preferred = options.preferred_primary_code;
  const preferredCandidate =
    preferred === undefined ? undefined : eligible.find((item) => item.record.code === preferred);
  const primary = preferredCandidate ?? eligible[0]!;
  const selected: SelectedCandidate[] = [primary];
  const remaining = eligible.filter((item) => item !== primary);
  const inspirations: SelectedCandidate[] = [];
  while (inspirations.length < 3) {
    const scored = remaining
      .filter((item) => !inspirations.includes(item))
      .map((item) => ({ item, gain: gainFor(item, selected, requestedCapabilities) }))
      .filter(({ gain }) => gain.value > 0)
      .sort((left, right) => {
        if (right.gain.value !== left.gain.value) return right.gain.value - left.gain.value;
        if (right.item.score !== left.item.score) return right.item.score - left.item.score;
        return (left.item.record.code ?? '').localeCompare(right.item.record.code ?? '');
      });
    const next = scored[0]?.item;
    if (next === undefined) break;
    inspirations.push(next);
    selected.push(next);
  }
  return {
    status: 'ready',
    primary,
    inspirations,
    rejected,
    reasons: [
      `Primary selected: ${primary.record.code}.`,
      inspirations.length === 0
        ? 'No additional template provides meaningful marginal capability or structural gain.'
        : `Selected ${inspirations.length} diverse inspiration template${inspirations.length === 1 ? '' : 's'}.`,
    ],
  };
}

// Short aliases keep the public surface ergonomic for callers that prefer stage names.
export const retrieveCandidates = retrieveMetadataCandidates;
export const selectPortfolio = selectTemplatePortfolio;
