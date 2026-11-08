import type { CallToolResult, Tool as McpTool } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { recordProgressiveDiscoveryEvidence } from './telemetry/performance-evidence.js';
import { type Concept, foldSearchText as normalize, queryIntent } from './tool-search-language.js';

export const PROGRESSIVE_SEARCH_TOOL_NAME = 'mcp_tools_search';
export const PROGRESSIVE_ARCHITECT_TOOL_NAME = 'build_discord_server';
export const PROGRESSIVE_READ_TOOL_NAME = 'mcp_tools_read';
export const PROGRESSIVE_WRITE_TOOL_NAME = 'mcp_tools_write';
export const PROGRESSIVE_DESTRUCTIVE_TOOL_NAME = 'mcp_tools_destructive';

export type ProgressiveDispatcherName =
  | typeof PROGRESSIVE_READ_TOOL_NAME
  | typeof PROGRESSIVE_WRITE_TOOL_NAME
  | typeof PROGRESSIVE_DESTRUCTIVE_TOOL_NAME;

const SEARCH_STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'cho',
  'co',
  'discord',
  'khi',
  'mot',
  'for',
  'in',
  'inside',
  'my',
  'of',
  'on',
  'or',
  'our',
  'please',
  'set',
  'the',
  'this',
  'toi',
  'to',
  'tool',
  'up',
  'va',
]);

const SearchArgsSchema = z
  .object({
    query: z
      .string()
      .max(200)
      .optional()
      .describe(
        'Capability or outcome to find in the user’s language, for example "đọc tin nhắn".',
      ),
    category: z
      .string()
      .max(64)
      .optional()
      .describe('Optional exact tool category. Omit query to browse this category.'),
    limit: z.number().int().min(1).max(20).default(8).describe('Maximum matches to return.'),
    detail: z
      .enum(['compact', 'full'])
      .default('compact')
      .describe(
        "compact returns short match cards. full includes every matching description and inputSchema. An exact tool-name search includes that tool's contract in either mode.",
      ),
  })
  .strict();

const DispatcherArgsSchema = z
  .object({
    tool: z.string().min(1).max(64).describe('Exact tool name returned by mcp_tools_search.'),
    args: z
      .record(z.string(), z.unknown())
      .describe('Arguments matching the inputSchema returned for that tool.'),
  })
  .strict();

const ERROR_ENVELOPE_SCHEMA = {
  type: 'object',
  properties: {
    code: { type: 'string' },
    retriable: { type: 'boolean' },
    category: { type: 'string', enum: ['client', 'server'] },
    recovery_hint: { type: 'string' },
  },
  required: ['code', 'retriable', 'category', 'recovery_hint'],
} as const;

export const PROGRESSIVE_SEARCH_TOOL: McpTool = {
  name: PROGRESSIVE_SEARCH_TOOL_NAME,
  description: [
    'Search the Discord tool catalog available to this caller.',
    "In this Discord integration, an unqualified request to build, design, or create a gaming or community server means a Discord guild, not a VPS or game-hosting machine, unless the user explicitly says otherwise; search with the user's request before asking which server type they mean.",
    'A single result includes its contract. For multiple compact results, search the selected exact tool name before dispatching.',
    'Set detail:"full" only when several full contracts are necessary. Omit both query and category to list categories.',
    'Use query_language as a reply-language hint when known. Tool names and schema keys are canonical.',
    'Search results never expand MCP_CATEGORIES permissions.',
  ].join(' '),
  inputSchema: z.toJSONSchema(SearchArgsSchema, {
    target: 'draft-2020-12',
    io: 'input',
  }) as McpTool['inputSchema'],
  outputSchema: {
    type: 'object',
    anyOf: [
      {
        type: 'object',
        properties: {
          query: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          category: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          query_language: { type: 'string', description: 'Detected query language, or und.' },
          detail: { type: 'string', enum: ['compact', 'full'] },
          total_matches: { type: 'integer' },
          matches: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                category: { type: 'string' },
                dispatcher: {
                  type: 'string',
                  enum: [
                    PROGRESSIVE_READ_TOOL_NAME,
                    PROGRESSIVE_WRITE_TOOL_NAME,
                    PROGRESSIVE_DESTRUCTIVE_TOOL_NAME,
                  ],
                },
                summary: { type: 'string' },
                description: { type: 'string' },
                inputSchema: { type: 'object' },
                annotations: { type: 'object' },
              },
              required: ['name', 'category', 'dispatcher', 'summary'],
            },
          },
          categories: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                tool_count: { type: 'integer' },
              },
              required: ['name', 'tool_count'],
            },
          },
        },
        required: ['query', 'category', 'detail', 'total_matches', 'matches'],
      },
      ERROR_ENVELOPE_SCHEMA,
    ],
  } as McpTool['outputSchema'],
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
};

function dispatcherTool(
  name: ProgressiveDispatcherName,
  description: string,
  annotations: NonNullable<McpTool['annotations']>,
): McpTool {
  return {
    name,
    description,
    inputSchema: z.toJSONSchema(DispatcherArgsSchema, {
      target: 'draft-2020-12',
      io: 'input',
    }) as McpTool['inputSchema'],
    annotations,
  };
}

export const PROGRESSIVE_DISPATCH_TOOLS: readonly McpTool[] = [
  dispatcherTool(
    PROGRESSIVE_READ_TOOL_NAME,
    'Invoke one read-only Discord tool returned by mcp_tools_search. The server rejects write or destructive tools on this dispatcher and still applies authorization, validation, resilience, and telemetry middleware.',
    {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  ),
  dispatcherTool(
    PROGRESSIVE_WRITE_TOOL_NAME,
    'Invoke one non-destructive write tool returned by mcp_tools_search. The server rejects read-only and destructive tools on this dispatcher and still applies all normal middleware.',
    {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  ),
  dispatcherTool(
    PROGRESSIVE_DESTRUCTIVE_TOOL_NAME,
    'Invoke one destructive tool returned by mcp_tools_search. Use the exact returned input schema, including __confirm:true when intended. The selected tool still requires MCP_DRY_RUN=false and passes every authorization and safety gate.',
    {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  ),
] as const;

function searchWords(text: string): string[] {
  return text
    .split(' ')
    .filter(Boolean)
    .map((word) =>
      word.length >= 5 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word,
    );
}

function normalizeCategory(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[\s-]+/g, '_');
}

interface SearchableTool {
  tool: McpTool;
  category: string;
  normalizedName: string;
  normalizedNameTerms: readonly string[];
  normalizedCategory: string;
  normalizedDescription: string;
  descriptionWords: ReadonlySet<string>;
  summary: string;
}

interface CachedToolMetadata {
  name: string;
  description: string;
  category: string;
  normalizedName: string;
  normalizedNameTerms: readonly string[];
  normalizedCategory: string;
  normalizedDescription: string;
  descriptionWords: ReadonlySet<string>;
  summary: string;
}

const cachedToolMetadata = new WeakMap<McpTool, CachedToolMetadata>();

const SERVER_ARCHITECTURE_SIGNALS = new Set([
  'automod',
  'channels',
  'complete',
  'events',
  'gaming',
  'lfg',
  'moderation',
  'onboarding',
  'permissions',
  'professional',
  'roles',
  'staff',
  'voice',
  'welcome',
]);

const SCOPED_RESOURCE_INTENT =
  /\b(?:add|build|create|design|dung|make|schedule|set up|setup|tao|them|lap|cap nhat|update)\b(?:\s+[a-z0-9]+){0,8}\s+\b(?:automod(?:\s+rule)?|channel|channels|emoji|emojis|event|events|invite|invites|kenh|message|messages|onboarding|role|roles|su kien|thread|threads|vai tro|webhook|webhooks)\b(?:\s+[a-z0-9]+){0,8}\s+\b(?:cho|for|in|inside|o|on|to|trong)\s+(?:(?:a|an|my|our|the|this|mot)\s+)?(?:(?:discord)\s+)?(?:community|guild|server)\b/;

const SCOPED_RESOURCE_TOOL_HINTS = [
  { pattern: /\b(?:event|events|su kien)\b/, toolName: 'events_create' },
  { pattern: /\b(?:channel|channels|kenh)\b/, toolName: 'channels_create_guild_channel' },
  { pattern: /\b(?:role|roles|vai tro)\b/, toolName: 'roles_create' },
] as const;

function isServerArchitectureIntent(
  query: string,
  termSet: ReadonlySet<string>,
  scopedResourceIntent: boolean,
): boolean {
  const hasScope = ['server', 'community', 'guild'].some((term) => termSet.has(term));
  if (!hasScope) return false;
  // Keep a resource-level request inside an existing guild on its narrow tool.
  // "Create a gaming event in my server" is not permission to redesign the server.
  if (scopedResourceIntent) return false;
  const hasStrongVerb =
    ['architect', 'build', 'design', 'dung', 'make', 'redesign', 'setup', 'tao'].some((term) =>
      termSet.has(term),
    ) || query.includes('set up');
  if (hasStrongVerb) return true;
  if (!termSet.has('create') && !termSet.has('tao')) return false;
  const breadth = [...SERVER_ARCHITECTURE_SIGNALS].filter((term) => termSet.has(term)).length;
  return breadth >= 2 || /\bcreate (?:a )?(?:discord )?server\b/.test(query);
}

export interface ProgressiveToolCatalog {
  searchable: readonly SearchableTool[];
  categories: readonly { name: string; tool_count: number }[];
  byCategory: ReadonlyMap<string, readonly SearchableTool[]>;
  byExactQuery: ReadonlyMap<string, SearchableTool>;
  byName: ReadonlyMap<string, McpTool>;
}

const TOOL_INTENTS: readonly [tool: string, entity: Concept, ...actions: Concept[]][] = [
  ['messages_search_recent', 'message', 'search'],
  ['messages_read', 'message', 'read', 'list', 'recent'],
  ['messages_send', 'message', 'send'],
  ['messages_delete', 'message', 'delete'],
  ['messages_edit', 'message', 'edit'],
  ['channels_list', 'channel', 'list'],
  ['channels_get', 'channel', 'read'],
  ['channels_create_guild_channel', 'channel', 'create'],
  ['channels_delete', 'channel', 'delete'],
  ['channels_modify', 'channel', 'edit'],
  ['roles_list', 'role', 'read', 'list'],
  ['roles_create', 'role', 'create'],
  ['roles_delete', 'role', 'delete'],
  ['roles_modify', 'role', 'edit'],
  ['members_add_role', 'role', 'assign'],
  ['members_list', 'member', 'list'],
  ['members_get', 'member', 'read'],
  ['members_search', 'member', 'search'],
  ['events_create', 'event', 'create'],
  ['events_list', 'event', 'read', 'list'],
  ['events_delete', 'event', 'delete'],
  ['events_modify', 'event', 'edit'],
  ['audit_log_get', 'audit', 'read', 'list', 'search'],
  ['messages_list_pins', 'pin', 'read', 'list', 'search'],
  ['invites_create_channel', 'invite', 'create'],
  ['automod_list_rules', 'automod', 'read', 'list'],
  ['automod_create_rule', 'automod', 'create'],
];

const READ_ACTIONS: readonly Concept[] = ['read', 'list', 'search'];
const WRITE_ACTIONS: readonly Concept[] = ['create', 'build', 'delete', 'assign', 'send', 'edit'];

interface SearchQuery {
  query: string;
  terms: readonly string[];
  wordWeights: ReadonlyMap<string, number>;
  preferredTools: ReadonlySet<string>;
  scopedResourceToolNames: ReadonlySet<string>;
  readOnly: boolean;
  hasCreateIntent: boolean;
  serverArchitectureIntent: boolean;
}

function scoreTool(tool: SearchableTool, search: SearchQuery): number {
  const { query, terms } = search;
  if (query === '') return 1;
  if (search.readOnly && tool.tool.annotations?.readOnlyHint !== true) return 0;

  let score = 0;
  if (tool.tool.name === 'guild_blueprint_plan' && search.serverArchitectureIntent) score += 360;
  if (search.scopedResourceToolNames.has(tool.tool.name)) score += 250;
  if (search.preferredTools.has(tool.tool.name)) score += 155;
  if (search.hasCreateIntent && tool.normalizedNameTerms.includes('create')) score += 40;
  if (tool.normalizedName.startsWith(query)) score += 80;
  if (tool.normalizedCategory === query) score += 40;
  if (terms.length > 1 && ` ${tool.normalizedDescription} `.includes(` ${query} `)) score += 90;
  const categoryTerms = searchWords(tool.normalizedCategory);
  for (const term of terms) {
    const weight = search.wordWeights.get(term) ?? 1;
    if (tool.normalizedNameTerms.includes(term)) score += 20 * weight;
    if (categoryTerms.includes(term)) score += 8 * weight;
    if (tool.descriptionWords.has(term)) score += 2 * weight;
  }
  return score;
}

function clientError(code: string, message: string, recoveryHint: string): CallToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text: `**${code}**: ${message}` }],
    structuredContent: {
      code,
      retriable: false,
      category: 'client',
      recovery_hint: recoveryHint,
    },
  };
}

function validationError(message: string): CallToolResult {
  return clientError(
    'VALIDATION_FAILED',
    message,
    'Use the exact schema advertised for this progressive tool.',
  );
}

function dispatcherFor(tool: McpTool): ProgressiveDispatcherName {
  if (tool.annotations?.readOnlyHint === true) return PROGRESSIVE_READ_TOOL_NAME;
  if (tool.annotations?.destructiveHint === true) return PROGRESSIVE_DESTRUCTIVE_TOOL_NAME;
  return PROGRESSIVE_WRITE_TOOL_NAME;
}

function compactSummary(description: string | undefined): string {
  const firstParagraph = (description ?? '').split(/\n\s*\n/, 1)[0] ?? '';
  const normalized = firstParagraph.replace(/\s+/g, ' ').trim();
  if (normalized.length <= 180) return normalized;
  return `${normalized.slice(0, 177).trimEnd()}...`;
}

/** Compile immutable search metadata once per server instead of per query. */
export function createProgressiveToolCatalog(
  visibleTools: readonly McpTool[],
  categoriesByName: ReadonlyMap<string, string>,
): ProgressiveToolCatalog {
  const searchable = visibleTools
    .filter((tool) => tool.name !== 'mcp_pipeline' && tool.name !== PROGRESSIVE_SEARCH_TOOL_NAME)
    .map((tool) => {
      const category = categoriesByName.get(tool.name) ?? 'unknown';
      const description = tool.description ?? '';
      let metadata = cachedToolMetadata.get(tool);
      if (
        metadata === undefined ||
        metadata.name !== tool.name ||
        metadata.description !== description ||
        metadata.category !== category
      ) {
        const normalizedName = normalize(tool.name);
        const normalizedDescription = normalize(description);
        metadata = {
          name: tool.name,
          description,
          category,
          normalizedName,
          normalizedNameTerms: searchWords(normalizedName),
          normalizedCategory: normalize(category),
          normalizedDescription,
          descriptionWords: new Set(searchWords(normalizedDescription)),
          summary: compactSummary(description),
        };
        cachedToolMetadata.set(tool, metadata);
      }
      return {
        tool,
        category,
        normalizedName: metadata.normalizedName,
        normalizedNameTerms: metadata.normalizedNameTerms,
        normalizedCategory: metadata.normalizedCategory,
        normalizedDescription: metadata.normalizedDescription,
        descriptionWords: metadata.descriptionWords,
        summary: metadata.summary,
      };
    });

  const byCategory = new Map<string, SearchableTool[]>();
  const byExactQuery = new Map<string, SearchableTool>();
  const byName = new Map<string, McpTool>();
  for (const entry of searchable) {
    const categoryTools = byCategory.get(entry.category);
    if (categoryTools === undefined) byCategory.set(entry.category, [entry]);
    else categoryTools.push(entry);
    byExactQuery.set(entry.normalizedName, entry);
    byName.set(entry.tool.name, entry.tool);
  }
  for (const tools of byCategory.values()) {
    tools.sort((left, right) => left.tool.name.localeCompare(right.tool.name));
  }

  const categories = [...byCategory]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, tools]) => ({ name, tool_count: tools.length }));

  return { searchable, categories, byCategory, byExactQuery, byName };
}

/**
 * Search only the already-authorized catalog passed by the server. This is a
 * presentation adapter for hosts without native deferred MCP loading, not an
 * authorization boundary; calls still re-enter the normal middleware chain.
 */
export function searchProgressiveTools(
  rawArgs: unknown,
  catalog: ProgressiveToolCatalog,
): CallToolResult {
  const parsed = SearchArgsSchema.safeParse(rawArgs ?? {});
  if (!parsed.success) {
    return validationError(parsed.error.issues.map((issue) => issue.message).join('; '));
  }

  const query = normalize(parsed.data.query ?? '');
  const categoryFilter =
    parsed.data.category === undefined ? undefined : normalizeCategory(parsed.data.category);

  const shouldListMatches = query !== '' || categoryFilter !== undefined;
  const isCategoryBrowse = query === '' && categoryFilter === undefined;
  const exact = query === '' ? undefined : catalog.byExactQuery.get(query);
  const exactInScope =
    exact !== undefined && (categoryFilter === undefined || exact.category === categoryFilter)
      ? exact
      : undefined;
  const intent =
    query === '' || exactInScope !== undefined
      ? undefined
      : queryIntent(parsed.data.query ?? '', query);
  const concepts = intent?.concepts ?? new Set<Concept>();
  const termSet = new Set(query.split(' ').filter((term) => term && !SEARCH_STOP_WORDS.has(term)));
  const terms = [...new Set([...searchWords([...termSet].join(' ')), ...concepts])];
  const preferredTools = new Set(
    TOOL_INTENTS.filter(
      ([, entity, ...actions]) =>
        concepts.has(entity) && actions.some((action) => concepts.has(action)),
    ).map(([name]) => name),
  );
  if (concepts.has('search')) preferredTools.delete('messages_read');
  if (concepts.has('pin') && concepts.has('message')) preferredTools.delete('messages_read');
  if (concepts.has('assign')) preferredTools.delete('roles_create');
  const scopedResourceIntent = SCOPED_RESOURCE_INTENT.test(query);
  const scopedResourceToolNames = new Set(
    scopedResourceIntent
      ? SCOPED_RESOURCE_TOOL_HINTS.filter(({ pattern }) => pattern.test(query)).map(
          ({ toolName }) => toolName,
        )
      : [],
  );
  const hasDeleteIntent = ['cancel', 'delete', 'remove'].some((term) => termSet.has(term));
  const hasCreateIntent =
    !hasDeleteIntent &&
    (query.includes('set up') ||
      ['add', 'build', 'create', 'dung', 'make', 'schedule', 'setup', 'tao'].some((term) =>
        termSet.has(term),
      ));
  const candidates =
    categoryFilter === undefined
      ? catalog.searchable
      : (catalog.byCategory.get(categoryFilter) ?? []);
  const wordWeights = new Map<string, number>();
  if (exactInScope === undefined) {
    for (const term of terms) {
      const count = candidates.filter(
        (entry) => entry.normalizedNameTerms.includes(term) || entry.descriptionWords.has(term),
      ).length;
      wordWeights.set(term, 1 + Math.log((candidates.length + 1) / (count + 1)));
    }
  }
  const search: SearchQuery = {
    query,
    terms,
    wordWeights,
    preferredTools,
    scopedResourceToolNames,
    readOnly:
      READ_ACTIONS.some((action) => concepts.has(action)) &&
      !WRITE_ACTIONS.some((action) => concepts.has(action)),
    hasCreateIntent,
    serverArchitectureIntent:
      isServerArchitectureIntent(query, termSet, scopedResourceIntent) ||
      (concepts.has('build') && concepts.has('guild') && !scopedResourceIntent) ||
      (concepts.has('create') && concepts.has('guild') && preferredTools.size === 0),
  };
  const ranked = !shouldListMatches
    ? []
    : exactInScope !== undefined
      ? [{ entry: exactInScope, score: 200 }]
      : candidates
          .map((entry) => ({ entry, score: scoreTool(entry, search) }))
          .filter(({ score }) => score > 0)
          .sort(
            (left, right) =>
              right.score - left.score || left.entry.tool.name.localeCompare(right.entry.tool.name),
          );

  const selected = ranked.slice(0, parsed.data.limit);
  const includeAllContracts = parsed.data.detail === 'full' || selected.length === 1;
  const matches = selected.map(({ entry }) => {
    const { tool, category } = entry;
    const includeContract = includeAllContracts || entry.normalizedName === query;
    return {
      name: tool.name,
      category,
      dispatcher: dispatcherFor(tool),
      summary: entry.summary,
      ...(includeContract
        ? {
            description: tool.description ?? '',
            inputSchema: tool.inputSchema,
            annotations: tool.annotations ?? {},
          }
        : {}),
    };
  });

  const structuredContent = {
    query: parsed.data.query ?? null,
    category: parsed.data.category ?? null,
    detail: parsed.data.detail,
    ...(intent === undefined ? {} : { query_language: intent.language }),
    total_matches: ranked.length,
    matches,
    ...(isCategoryBrowse ? { categories: catalog.categories } : {}),
  };
  recordProgressiveDiscoveryEvidence(structuredContent);

  return {
    isError: false,
    content: [
      {
        type: 'text',
        text: shouldListMatches
          ? includeAllContracts
            ? `Found ${ranked.length} matching tool(s); returned ${matches.length} full contract(s). Use each match's exact dispatcher, tool name, and input schema.`
            : `Found ${ranked.length} matching tool(s); returned ${matches.length} compact match(es). Search an exact tool name to load its input schema before dispatching.`
          : `Available categories: ${catalog.categories.map((item) => `${item.name} (${item.tool_count})`).join(', ')}.`,
      },
    ],
    structuredContent,
  };
}

export type ProgressiveInvoke = (
  toolName: string,
  args: unknown,
  signal: AbortSignal,
) => Promise<CallToolResult>;

/** Dispatch one discovered tool while enforcing the risk-specific route. */
export async function dispatchProgressiveTool(
  dispatcher: ProgressiveDispatcherName,
  rawArgs: unknown,
  catalog: ProgressiveToolCatalog,
  invoke: ProgressiveInvoke,
  signal: AbortSignal,
): Promise<CallToolResult> {
  const parsed = DispatcherArgsSchema.safeParse(rawArgs ?? {});
  if (!parsed.success) {
    return validationError(parsed.error.issues.map((issue) => issue.message).join('; '));
  }

  const tool = catalog.byName.get(parsed.data.tool);
  if (tool === undefined) {
    return clientError(
      'TOOL_NOT_AVAILABLE',
      `Tool '${parsed.data.tool}' is not available to progressive discovery.`,
      'Search again with mcp_tools_search. Check MCP_CATEGORIES if the expected tool is absent.',
    );
  }

  const expectedDispatcher = dispatcherFor(tool);
  if (dispatcher !== expectedDispatcher) {
    return clientError(
      'DISPATCH_MODE_MISMATCH',
      `Tool '${tool.name}' must be called with '${expectedDispatcher}', not '${dispatcher}'.`,
      `Use dispatcher:'${expectedDispatcher}' from the latest mcp_tools_search result.`,
    );
  }

  return invoke(tool.name, parsed.data.args, signal);
}
