import type { CallToolResult, Tool as McpTool } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { recordProgressiveDiscoveryEvidence } from './telemetry/performance-evidence.js';

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
      .describe('Capability or outcome to find, for example "send a message" or "ban member".'),
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
        required: ['query', 'category', 'detail', 'total_matches', 'matches', 'categories'],
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

function normalize(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/đ/g, 'd')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
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
  normalizedCategory: string;
  normalizedDescription: string;
}

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

function scopedResourceToolBoost(tool: SearchableTool, query: string): number {
  if (!SCOPED_RESOURCE_INTENT.test(query)) return 0;
  return SCOPED_RESOURCE_TOOL_HINTS.some(
    ({ pattern, toolName }) => pattern.test(query) && tool.tool.name === toolName,
  )
    ? 220
    : 0;
}

function isServerArchitectureIntent(query: string, terms: readonly string[]): boolean {
  const termSet = new Set(terms);
  const hasScope = ['server', 'community', 'guild'].some((term) => termSet.has(term));
  if (!hasScope) return false;
  // Keep a resource-level request inside an existing guild on its narrow tool.
  // "Create a gaming event in my server" is not permission to redesign the server.
  if (SCOPED_RESOURCE_INTENT.test(query)) return false;
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

function scoreTool(tool: SearchableTool, query: string, terms: readonly string[]): number {
  if (query === '') return 1;

  let score = 0;
  const termSet = new Set(terms);

  if (tool.normalizedName === query) score += 200;
  if (tool.tool.name === 'guild_blueprint_plan' && isServerArchitectureIntent(query, terms)) {
    score += 300;
  }
  score += scopedResourceToolBoost(tool, query);
  const hasDeleteIntent = ['cancel', 'delete', 'remove'].some((term) => termSet.has(term));
  const hasCreateIntent =
    !hasDeleteIntent &&
    (query.includes('set up') ||
      ['add', 'build', 'create', 'dung', 'make', 'schedule', 'setup', 'tao'].some((term) =>
        termSet.has(term),
      ));
  if (hasCreateIntent && tool.normalizedName.split(' ').includes('create')) score += 60;
  if (tool.normalizedName.startsWith(query)) score += 80;
  if (tool.normalizedCategory === query) score += 40;
  let descriptionMatches = 0;
  for (const term of terms) {
    if (tool.normalizedName.includes(term)) score += 25;
    if (tool.normalizedCategory.includes(term)) score += 12;
    if (tool.normalizedDescription.includes(term)) {
      score += 4;
      descriptionMatches += 1;
    }
  }
  if (descriptionMatches >= 2 && terms.length >= 2) {
    score += Math.round((descriptionMatches / terms.length) * 80) + descriptionMatches * 3;
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
      return {
        tool,
        category,
        normalizedName: normalize(tool.name),
        normalizedCategory: normalize(category),
        normalizedDescription: normalize(tool.description ?? ''),
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
  const exact = query === '' ? undefined : catalog.byExactQuery.get(query);
  const exactInScope =
    exact !== undefined && (categoryFilter === undefined || exact.category === categoryFilter)
      ? exact
      : undefined;
  const terms = [
    ...new Set(query.split(' ').filter((term) => term !== '' && !SEARCH_STOP_WORDS.has(term))),
  ];
  const candidates =
    categoryFilter === undefined
      ? catalog.searchable
      : (catalog.byCategory.get(categoryFilter) ?? []);
  const ranked = !shouldListMatches
    ? []
    : exactInScope !== undefined
      ? [{ entry: exactInScope, score: 200 }]
      : candidates
          .map((entry) => ({ entry, score: scoreTool(entry, query, terms) }))
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
      summary: compactSummary(tool.description),
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
    total_matches: ranked.length,
    matches,
    categories: catalog.categories,
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
