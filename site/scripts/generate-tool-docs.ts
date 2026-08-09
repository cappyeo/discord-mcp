/**
 * Auto-generate the tools reference section of the docs site.
 *
 * Reads the static `__toolMetadata` attached to every class returned by
 * `defineTool()` (see packages/mcp-core/src/tools/_lib/defineTool.ts) via
 * dynamic `import()` of each tool source file. Renders one MDX page per
 * tool, one index per category, and a top-level tools index - 202 + 31 + 1
 * pages total.
 *
 * Run via `pnpm --filter site generate-tools`. Requires `tsx` to register
 * the TypeScript loader for dynamic .ts imports.
 */
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
// Resolve zod via the mcp-core workspace package - pnpm ensures
// packages/mcp-core/node_modules/zod is always present for the workspace,
// avoiding a duplicate zod copy at site/node_modules that would conflict
// with Astro's content schema (which uses its own bundled zod via
// astro:content).
import { z } from '../../packages/mcp-core/node_modules/zod/index.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(__dirname, '../..');
const TOOLS_DIR = join(ROOT, 'packages/mcp-core/src/tools');
const OUT_DIR = join(__dirname, '../src/content/docs/tools');

export interface ToolMetadata {
  name: string;
  category: string;
  description: string;
  inputSchema: Record<string, z.ZodTypeAny>;
  outputSchema: Record<string, z.ZodTypeAny> | undefined;
  annotations: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
  idempotent: boolean;
  preconditions: readonly string[];
  sourcePath: string;
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export async function loadAllTools(toolsDir: string = TOOLS_DIR): Promise<ToolMetadata[]> {
  const tools: ToolMetadata[] = [];
  const categories = readdirSync(toolsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('_'))
    .map((e) => e.name);

  for (const category of categories) {
    const categoryDir = join(toolsDir, category);
    const files = readdirSync(categoryDir).filter(
      (f) =>
        f.endsWith('.ts') &&
        !f.endsWith('.test.ts') &&
        !f.endsWith('.bench.ts') &&
        !f.startsWith('_'),
    );
    for (const file of files) {
      const sourcePath = join(categoryDir, file);
      const moduleUrl = `file://${sourcePath.replace(/\\/g, '/')}`;
      try {
        const mod = await import(moduleUrl);
        const toolClass = mod.default;
        const metadata = (toolClass as { __toolMetadata?: unknown })?.__toolMetadata;
        if (!metadata || typeof metadata !== 'object') {
          console.warn(`[skip] ${relative(ROOT, sourcePath)} - no __toolMetadata`);
          continue;
        }
        const m = metadata as Record<string, unknown>;
        tools.push({
          name: m.name as string,
          category: m.category as string,
          description: m.description as string,
          inputSchema: m.inputSchema as Record<string, z.ZodTypeAny>,
          outputSchema: m.outputSchema as Record<string, z.ZodTypeAny> | undefined,
          annotations: m.annotations as ToolMetadata['annotations'],
          idempotent: (m.idempotent as boolean) ?? false,
          preconditions: (m.preconditions as readonly string[]) ?? [],
          sourcePath,
        });
      } catch (e) {
        console.warn(
          `[error] ${relative(ROOT, sourcePath)}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
  }
  return tools;
}

// ---------------------------------------------------------------------------
// Tool MDX renderer
// ---------------------------------------------------------------------------

/**
 * Tool descriptions follow the established 4-section format used across the
 * 202 tools. Headings are bold-asterisk markdown - capture body text up to
 * the next bold-asterisk heading or end of string.
 */
export function parseDescription(desc: string): {
  purpose: string;
  whenToUse: string;
  whenNotToUse: string;
  returns: string;
  extraSections: Array<{ heading: string; body: string }>;
} {
  const sections = {
    purpose: '',
    whenToUse: '',
    whenNotToUse: '',
    returns: '',
    extraSections: [] as Array<{ heading: string; body: string }>,
  };

  const sectionRegex = /\*\*([^*]+)\*\*:\s*([\s\S]*?)(?=\n\s*\*\*[^*]+\*\*:|$)/g;
  for (const m of desc.matchAll(sectionRegex)) {
    const originalHeading = (m[1] ?? '').trim();
    const heading = originalHeading.toLowerCase();
    const body = (m[2] ?? '').trim();
    if (heading === 'purpose') sections.purpose = body;
    else if (heading === 'when to use') sections.whenToUse = body;
    else if (heading === 'when not to use') sections.whenNotToUse = body;
    else if (heading === 'returns') sections.returns = body;
    else sections.extraSections.push({ heading: originalHeading, body });
  }

  return sections;
}

/**
 * Escape characters MDX would interpret as JSX. Tool descriptions sometimes
 * contain `<channel_id>` placeholders or `{key:value}` examples that MDX
 * would otherwise try to parse as JSX expressions.
 */
export function escapeMdx(s: string): string {
  return s.replace(/</g, '\\<').replace(/\{/g, '\\{').replace(/\}/g, '\\}');
}

/** Escape MDX syntax in prose without adding visible backslashes inside code spans. */
export function escapeMdxProse(s: string): string {
  return s
    .split(/(`[^`\n]*`)/g)
    .map((part) => (part.startsWith('`') && part.endsWith('`') ? part : escapeMdx(part)))
    .join('');
}

type JsonSchema = Record<string, unknown>;

function cleanJsonSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cleanJsonSchema);
  if (typeof value !== 'object' || value === null) return value;
  const cleaned: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (
      (key === 'minimum' && child === Number.MIN_SAFE_INTEGER) ||
      (key === 'maximum' && child === Number.MAX_SAFE_INTEGER)
    ) {
      continue;
    }
    cleaned[key] = cleanJsonSchema(child);
  }
  return cleaned;
}

function schemaType(schema: JsonSchema): string {
  if (Array.isArray(schema.enum))
    return schema.enum.map((value) => JSON.stringify(value)).join(' | ');
  if ('const' in schema) return JSON.stringify(schema.const);
  if (Array.isArray(schema.type)) return schema.type.join(' | ');
  if (typeof schema.type === 'string') {
    if (schema.type === 'array' && schema.items && typeof schema.items === 'object') {
      return `array<${schemaType(schema.items as JsonSchema)}>`;
    }
    return schema.type;
  }
  for (const key of ['anyOf', 'oneOf'] as const) {
    const variants = schema[key];
    if (Array.isArray(variants)) {
      return variants
        .filter((variant): variant is JsonSchema => typeof variant === 'object' && variant !== null)
        .map(schemaType)
        .join(' | ');
    }
  }
  return 'unknown';
}

function schemaConstraints(schema: JsonSchema): string {
  const constraints: string[] = [];
  if ('default' in schema) constraints.push(`default: \`${JSON.stringify(schema.default)}\``);
  if (Array.isArray(schema.enum)) {
    constraints.push(`one of ${schema.enum.map((value) => `\`${String(value)}\``).join(', ')}`);
  }
  const labels: Record<string, string> = {
    minimum: 'min',
    maximum: 'max',
    minLength: 'min length',
    maxLength: 'max length',
    minItems: 'min items',
    maxItems: 'max items',
    pattern: 'pattern',
    format: 'format',
  };
  for (const [key, label] of Object.entries(labels)) {
    if (
      (key === 'minimum' && schema[key] === Number.MIN_SAFE_INTEGER) ||
      (key === 'maximum' && schema[key] === Number.MAX_SAFE_INTEGER)
    ) {
      continue;
    }
    if (key in schema) constraints.push(`${label}: \`${String(schema[key])}\``);
  }
  return constraints.join('; ');
}

export function renderSchemaTable(
  fields: Record<string, z.ZodTypeAny> | undefined,
  io: 'input' | 'output' = 'input',
): string {
  if (!fields || Object.keys(fields).length === 0) return '*(no fields)*';

  const objSchema = z.object(fields);
  let jsonSchema: { properties?: Record<string, JsonSchema>; required?: string[] };
  try {
    jsonSchema = z.toJSONSchema(objSchema, { target: 'draft-2020-12', io }) as typeof jsonSchema;
  } catch (e) {
    return `*(schema introspection failed: ${e instanceof Error ? e.message : String(e)})*`;
  }

  const props = jsonSchema.properties ?? {};
  const required = new Set(jsonSchema.required ?? []);

  const rows: string[] = [
    '| Field | Type | Required | Constraints | Description |',
    '|---|---|---|---|---|',
  ];
  for (const [name, prop] of Object.entries(props)) {
    const type = escapeMdx(schemaType(prop)).replace(/\|/g, '\\|');
    // z.default() is optional for callers even though Zod's output JSON Schema
    // lists it as required after default materialization.
    const req = required.has(name) && !('default' in prop) ? 'yes' : 'no';
    // Description text appears inside an MDX paragraph. Escape `<`, `{`, `}`
    // so placeholders like `<channel_id>` and `{{...}}` render as text.
    const description = escapeMdxProse(typeof prop.description === 'string' ? prop.description : '')
      .replace(/\|/g, '\\|')
      .replace(/\n/g, ' ');
    const constraints = schemaConstraints(prop).replace(/\|/g, '\\|');
    rows.push(`| \`${name}\` | ${type} | ${req} | ${constraints} | ${description} |`);
  }
  return rows.join('\n');
}

export function renderJsonSchema(
  fields: Record<string, z.ZodTypeAny> | undefined,
  io: 'input' | 'output' = 'input',
): string {
  if (!fields) return '';
  try {
    return JSON.stringify(
      cleanJsonSchema(z.toJSONSchema(z.object(fields), { target: 'draft-2020-12', io })),
      null,
      2,
    );
  } catch {
    return '';
  }
}

function jsonSchemaExample(name: string, schema: JsonSchema): unknown {
  if ('const' in schema) return schema.const;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];

  for (const key of ['anyOf', 'oneOf'] as const) {
    const variants = schema[key];
    if (Array.isArray(variants)) {
      const first = variants.find(
        (variant): variant is JsonSchema =>
          typeof variant === 'object' && variant !== null && variant.type !== 'null',
      );
      if (first) return jsonSchemaExample(name, first);
    }
  }

  if (schema.type === 'object' || schema.properties) {
    const properties =
      schema.properties && typeof schema.properties === 'object'
        ? (schema.properties as Record<string, JsonSchema>)
        : {};
    const required = new Set(Array.isArray(schema.required) ? schema.required : []);
    return Object.fromEntries(
      Object.entries(properties)
        .filter(([property]) => required.has(property))
        .map(([property, propertySchema]) => [
          property,
          jsonSchemaExample(property, propertySchema),
        ]),
    );
  }

  if (schema.type === 'array') {
    const item =
      schema.items && typeof schema.items === 'object'
        ? jsonSchemaExample(name.replace(/s$/, ''), schema.items as JsonSchema)
        : null;
    const count = Math.max(1, typeof schema.minItems === 'number' ? schema.minItems : 1);
    return Array.from({ length: count }, () => item);
  }

  if (schema.type === 'boolean') return true;
  if (schema.type === 'integer' || schema.type === 'number') {
    const description = typeof schema.description === 'string' ? schema.description : '';
    const documentedValue = description.match(/\((\d+)\s+[A-Z_]/)?.[1];
    if (documentedValue) return Number(documentedValue);
    const minimum =
      typeof schema.minimum === 'number'
        ? schema.minimum
        : typeof schema.exclusiveMinimum === 'number'
          ? schema.exclusiveMinimum + 1
          : Number.NEGATIVE_INFINITY;
    const maximum = typeof schema.maximum === 'number' ? schema.maximum : Number.POSITIVE_INFINITY;
    for (const candidate of [1, 0]) {
      if (candidate >= minimum && candidate <= maximum) return candidate;
    }
    return Number.isFinite(minimum) ? minimum : Number.isFinite(maximum) ? maximum : 1;
  }

  if (schema.type === 'null') return null;

  const lowerName = name.toLowerCase();
  const format = typeof schema.format === 'string' ? schema.format : '';
  const pattern = typeof schema.pattern === 'string' ? schema.pattern : '';
  const description = typeof schema.description === 'string' ? schema.description : '';
  if (lowerName.endsWith('_id') || lowerName === 'id' || pattern.includes('17,20')) {
    return '123456789012345678';
  }
  if (format === 'uri' || format === 'url' || lowerName.includes('url')) {
    return 'https://example.com/resource';
  }
  if (
    format.includes('date-time') ||
    lowerName.includes('timestamp') ||
    lowerName.endsWith('_time')
  ) {
    return '2030-01-01T10:00:00.000Z';
  }
  if (lowerName.includes('emoji')) return '👍';
  if (lowerName === 'sound' && pattern.includes('data:audio')) return 'data:audio/mpeg;base64,SUQz';
  if (/base64 data uri/i.test(description)) return 'data:image/png;base64,iVBORw0KGgo=';
  if (/bitfield|stringified integer|integer bits/i.test(description)) return '0';
  if (lowerName.includes('token')) {
    const minimumLength = typeof schema.minLength === 'number' ? schema.minLength : 1;
    return 'REPLACE_WITH_TOKEN'.padEnd(minimumLength, 'x');
  }
  if (lowerName.includes('content') || lowerName.includes('message') || lowerName === 'text') {
    return 'Hello from discord-mcp';
  }
  if (lowerName.includes('reason')) return 'Requested by an administrator';
  if (lowerName.includes('name') || lowerName.includes('title')) return 'Example name';

  const minimumLength = typeof schema.minLength === 'number' ? schema.minLength : 1;
  return 'example'.padEnd(minimumLength, 'x');
}

export function buildSchemaExample(
  fields: Record<string, z.ZodTypeAny> | undefined,
  options: { includeOptional?: boolean; toolName?: string; io?: 'input' | 'output' } = {},
): Record<string, unknown> | undefined {
  if (!fields) return undefined;
  let jsonSchema: { properties?: Record<string, JsonSchema>; required?: string[] };
  try {
    jsonSchema = z.toJSONSchema(z.object(fields), {
      target: 'draft-2020-12',
      io: options.io ?? 'input',
    }) as typeof jsonSchema;
  } catch {
    return undefined;
  }

  const example: Record<string, unknown> = {};
  const required = new Set(jsonSchema.required ?? []);
  for (const name of Object.keys(fields)) {
    if (!options.includeOptional && !required.has(name)) continue;
    const propertySchema = jsonSchema.properties?.[name];
    if (!propertySchema) return undefined;
    example[name] = jsonSchemaExample(name, propertySchema);
  }

  if (!('content' in example) && fields.content) {
    const contentSchema = jsonSchema.properties?.content;
    if (contentSchema) example.content = jsonSchemaExample('content', contentSchema);
  }

  // Discord scheduled events require a channel for Stage and Voice variants.
  // Use a Voice event with an explicit channel so the example is valid beyond
  // Zod's field-level checks.
  if (options.toolName === 'events_create' && fields.entity_type && fields.channel_id) {
    example.entity_type = 2;
    example.channel_id = '123456789012345678';
  }

  if (options.toolName?.startsWith('components_v2_') && fields.components) {
    example.components = [{ type: 10, content: 'Hello from discord-mcp' }];
  }

  // Zod validates fields independently, while Discord also enforces several
  // cross-field contracts. Keep the published copy-ready examples valid at
  // that boundary instead of merely schema-valid.
  if (
    (options.toolName === 'commands_create_global' ||
      options.toolName === 'commands_create_guild') &&
    fields.description
  ) {
    example.type = 1;
    example.description = 'Example command description';
  }

  if (
    (options.toolName === 'commands_bulk_overwrite_global' ||
      options.toolName === 'commands_bulk_overwrite_guild') &&
    Array.isArray(example.commands) &&
    typeof example.commands[0] === 'object' &&
    example.commands[0] !== null
  ) {
    example.commands[0] = {
      ...example.commands[0],
      type: 1,
      description: 'Example command description',
    };
  }

  if (options.toolName === 'channels_forum_create_thread' && fields.message) {
    example.message = { content: 'Hello from discord-mcp' };
  }

  if (options.toolName === 'stickers_create_guild_sticker' && fields.file_format) {
    example.file_format = 1;
  }

  if (options.toolName === 'commands_edit_command_permissions' && fields.bearer_token) {
    example.bearer_token = 'REPLACE_WITH_USER_OAUTH_TOKEN';
  }

  if (options.toolName === 'mcp_pipeline' && fields.steps) {
    example.steps = [{ id: 'me', tool: 'users_get_current', args: {} }];
  }

  if (options.toolName === 'onboarding_modify' && Array.isArray(example.prompts)) {
    example.prompts = [];
    example.default_channel_ids = [];
    example.enabled = false;
    example.mode = 0;
  }

  if (options.toolName === 'roles_modify_positions' && Array.isArray(example.positions)) {
    example.positions = [{ id: '123456789012345678', position: 1 }];
  }

  if (options.toolName === 'permissions_explain') {
    example.user_id = '123456789012345679';
    example.channel_id = '123456789012345680';
    example.action = 'send_messages';
  }

  if (options.toolName === 'messages_bulk_delete' && fields.message_ids) {
    example.message_ids = ['123456789012345678', '123456789012345679'];
  }

  if (options.toolName === 'automod_create_rule' && fields.trigger_type) {
    // SPAM is the only useful trigger that intentionally has no metadata,
    // which keeps the minimal example valid without inventing a keyword set.
    example.trigger_type = 3;
  }

  if (options.toolName === 'intelligence_classify_messages' && fields.categories) {
    example.categories = ['support', 'spam'];
  }

  if (options.toolName === 'interactions_create_response' && fields.data) {
    example.type = 4;
    example.data = { content: 'Hello from discord-mcp' };
  }

  // Modify endpoints commonly make every mutable property optional. Publish
  // one focused change rather than an ID-only no-op or every optional field.
  if (options.toolName?.includes('modify')) {
    const identityField = /(^|_)(id|token)$|^audit_reason$|^permissions$/;
    const mutableField = Object.keys(fields).find(
      (name) => !(name in example) && !identityField.test(name),
    );
    if (mutableField) {
      const propertySchema = jsonSchema.properties?.[mutableField];
      if (propertySchema) example[mutableField] = jsonSchemaExample(mutableField, propertySchema);
    }
  }

  return z.object(fields).safeParse(example).success ? example : undefined;
}

export function buildOutputExample(tool: ToolMetadata): Record<string, unknown> | undefined {
  const authored: Record<string, Record<string, unknown>> = {
    components_v2_build_container: {
      component: { type: 17, components: [{ type: 10, content: 'Hello from discord-mcp' }] },
    },
    components_v2_build_section: {
      component: {
        type: 9,
        components: [{ type: 10, content: 'Hello from discord-mcp' }],
        accessory: { type: 11, media: { url: 'https://example.com/image.png' } },
      },
    },
    components_v2_build_media_gallery: {
      component: { type: 12, items: [{ media: { url: 'https://example.com/image.png' } }] },
    },
    webhooks_execute: { enqueued: true },
    intelligence_summarize_channel: {
      summary: 'The team shipped the release and assigned one follow-up.',
      key_topics: ['release'],
      action_items: ['Verify the rollout'],
      message_count_used: 20,
      sampling_used: true,
    },
    intelligence_classify_messages: {
      classifications: [
        {
          message_id: '123456789012345678',
          author: 'alice',
          category: 'support',
          confidence: 0.9,
        },
      ],
      count: 1,
      sampling_used: true,
    },
    intelligence_extract_entities: {
      entities: [{ type: 'action_item', value: 'Verify the rollout' }],
      count: 1,
      sampling_used: true,
    },
    intelligence_moderate_content: {
      decision: 'allow',
      reasons: [],
      confidence: 0.95,
      sampling_used: true,
    },
    intelligence_draft_response: {
      draft: 'Thanks - we are checking this now.',
      reasoning: 'Acknowledges the report without overpromising.',
      sampling_used: true,
    },
  };
  const candidate = authored[tool.name] ?? buildSchemaExample(tool.outputSchema, { io: 'output' });
  if (!candidate || !tool.outputSchema) return candidate;
  return z.object(tool.outputSchema).safeParse(candidate).success ? candidate : undefined;
}

function stripInlineMarkdown(value: string): string {
  return value
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^[-*]\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function renderAuthoredSection(heading: string, body: string): string {
  return `## ${heading}\n\n${escapeMdxProse(body)}`;
}

function renderAuthoredExample(body: string): string {
  if (body.includes('```')) return `**Tool-authored example**\n\n${body}`;
  if (/^\s*`[^`]+`[.]?\s*$/.test(body)) return `> **Tool-authored shorthand:** ${body}`;
  return `**Tool-authored example**\n\n\`\`\`text\n${body}\n\`\`\``;
}

const confirmField = z
  .boolean()
  .optional()
  .describe(
    'Set true to authorize this destructive operation. Also requires MCP_DRY_RUN=false; otherwise the server returns DRY_RUN_PREVIEW.',
  );

function renderAccessGuidance(tool: ToolMetadata): string {
  const categoryAccess =
    tool.category === 'meta'
      ? '- The `meta` category remains available even when `MCP_CATEGORIES` is restricted.'
      : `- The \`${tool.category}\` category must be enabled by \`MCP_CATEGORIES\` when an allowlist is set.`;

  if (tool.inputSchema.bearer_token) {
    return `${categoryAccess}
- This endpoint uses the supplied user OAuth2 bearer token, not the bot token. The user and OAuth grant must authorize the operation.
- Treat \`bearer_token\` as a credential. Invalid, expired, or insufficient grants surface as authentication or permission errors.`;
  }
  if (tool.inputSchema.interaction_token) {
    return `${categoryAccess}
- Discord authorizes this endpoint with the interaction token in the route; it does not use the bot's guild role.
- Interaction tokens are scoped and time-limited. An invalid, expired, or mismatched token returns an authentication or not-found error.`;
  }
  if (tool.category === 'webhooks' && tool.inputSchema.token) {
    return `${categoryAccess}
- Discord authorizes this endpoint with the webhook token in the route; no bot authorization header is sent.
- Treat \`token\` as a credential. Invalid or mismatched webhook IDs and tokens surface as authentication or not-found errors.`;
  }
  if (tool.name === 'guild_get_widget') {
    return `${categoryAccess}
- Discord serves the public widget anonymously; the bot's guild role is not involved.
- The guild widget must be enabled. A disabled widget or invalid guild ID returns a not-found or access error.`;
  }
  if (!tool.annotations.openWorldHint) {
    return `${categoryAccess}
- This tool is local-only and does not call Discord. Schema or domain validation can still reject malformed input.`;
  }
  return `${categoryAccess}
- This endpoint uses the configured bot credential and Discord's route-specific authorization; discord-mcp does not elevate access.
- An invalid credential returns a \`401\`-class tool error. Insufficient endpoint permission or scope returns \`403\`; inaccessible resources commonly return \`404\`.`;
}

export function renderToolMdx(tool: ToolMetadata, relatedTools: ToolMetadata[] = []): string {
  const desc = parseDescription(tool.description);
  const requiresConfirm = tool.preconditions.includes('confirm_required');
  const publishedInputSchema = requiresConfirm
    ? { ...tool.inputSchema, __confirm: confirmField }
    : tool.inputSchema;
  const inputTable = renderSchemaTable(publishedInputSchema);
  const outputTable = renderSchemaTable(tool.outputSchema, 'output');
  const inputSchema = renderJsonSchema(publishedInputSchema, 'input');
  const outputSchema = renderJsonSchema(tool.outputSchema, 'output');
  const generatedInputExample = buildSchemaExample(publishedInputSchema, { toolName: tool.name });
  const inputExample =
    generatedInputExample && requiresConfirm
      ? { ...generatedInputExample, __confirm: true }
      : generatedInputExample;
  const outputExample = buildOutputExample(tool);

  const sourceRelative = relative(ROOT, tool.sourcePath).replace(/\\/g, '/');
  const ghUrl = `https://github.com/cappyeo/discord-mcp/blob/main/${sourceRelative}`;
  const ghEditUrl = `https://github.com/cappyeo/discord-mcp/edit/main/${sourceRelative}`;

  // Wrap in single quotes (YAML safe-mode) so colons, brackets, and other YAML
  // metacharacters in the description don't break frontmatter parsing.
  // YAML escapes single quotes by doubling them.
  const fmDescRaw = desc.purpose.replace(/\n/g, ' ').slice(0, 150).trim();
  const fmDesc = `'${fmDescRaw.replace(/'/g, "''")}'`;

  const a = tool.annotations;
  const authoredExamples = desc.extraSections
    .filter(({ heading, body }) => heading.toLowerCase() === 'example' && body.length > 0)
    .map(({ body }) => renderAuthoredExample(body))
    .join('\n\n');
  const authoredSections = desc.extraSections
    .filter(({ heading, body }) => heading.toLowerCase() !== 'example' && body.length > 0)
    .map(({ heading, body }) => renderAuthoredSection(heading, body))
    .join('\n\n');
  const currentIndex = relatedTools.findIndex((relatedTool) => relatedTool.name === tool.name);
  const related = relatedTools
    .map((relatedTool, index) => ({ relatedTool, distance: Math.abs(index - currentIndex) }))
    .filter(({ relatedTool }) => relatedTool.name !== tool.name)
    .sort((a, b) => a.distance - b.distance || a.relatedTool.name.localeCompare(b.relatedTool.name))
    .slice(0, 4)
    .map(({ relatedTool }) => {
      const slug = relatedTool.name.startsWith(`${tool.category}_`)
        ? relatedTool.name.slice(tool.category.length + 1)
        : relatedTool.name;
      return `- [\`${relatedTool.name}\`](/discord-mcp/tools/${tool.category}/${slug}/)`;
    })
    .join('\n');

  return `---
title: ${tool.name}
description: ${fmDesc}
type: reference
sidebar:
  hidden: true
prev: false
next: false
editUrl: ${ghEditUrl}
---

import { Badge } from '@astrojs/starlight/components';

<p class="tool-meta">
  <a href="/discord-mcp/tools/${tool.category}/"><Badge text="${titleCaseCategory(tool.category)}" variant="note" /></a>{' '}
  ${a.readOnlyHint ? '<Badge text="Read only" variant="success" />' : '<Badge text="Writes to Discord" variant="caution" />'}{' '}
  ${a.destructiveHint ? '<Badge text="Destructive" variant="danger" />' : ''}
  ${requiresConfirm ? '<Badge text="Confirmation required" variant="tip" />' : ''}
</p>

${escapeMdxProse(desc.purpose)}

${desc.whenToUse ? `## When to use\n\n${escapeMdxProse(desc.whenToUse)}` : ''}

${desc.whenNotToUse ? `## When not to use\n\n${escapeMdxProse(desc.whenNotToUse)}` : ''}

${authoredSections}

${inputExample ? `## MCP call example\n\n${authoredExamples ? `${authoredExamples}\n\n` : ''}${requiresConfirm ? '> **Execution example:** first omit `__confirm` to get a safe `DRY_RUN_PREVIEW`. The payload below executes only when the server also runs with `MCP_DRY_RUN=false`.\n\n' : ''}\`\`\`json\n${JSON.stringify({ name: tool.name, arguments: inputExample }, null, 2)}\n\`\`\`` : ''}

## Input

${inputTable}

${inputSchema ? `<details>\n<summary>Complete input JSON Schema</summary>\n\n\`\`\`json\n${inputSchema}\n\`\`\`\n\n</details>` : ''}

## Returns

${escapeMdxProse(desc.returns || 'The structured result returned by the Discord API adapter.')}

${outputExample ? `### Example structured result\n\n\`\`\`json\n${JSON.stringify(outputExample, null, 2)}\n\`\`\`` : ''}

### Output schema

${outputTable}

${outputSchema ? `<details>\n<summary>Complete output JSON Schema</summary>\n\n\`\`\`json\n${outputSchema}\n\`\`\`\n\n</details>` : ''}

## Annotations

| Property | Value |
|---|---|
| Read-only | ${a.readOnlyHint ? 'yes' : 'no'} |
| Destructive | ${a.destructiveHint ? 'yes' : 'no'} |
| Idempotent | ${a.idempotentHint ? 'yes' : 'no'} |
| Open-world | ${a.openWorldHint ? 'yes' : 'no'} |
| Confirmation required | ${requiresConfirm ? 'yes (`__confirm:true` required)' : 'no'} |

## Access and common errors

${renderAccessGuidance(tool)}

${
  a.openWorldHint
    ? `## Trust boundary

Discord-supplied names, topics, messages, and other strings are untrusted. Fields in
\`structuredContent\` may remain raw even when the companion human-readable \`content\`
or an \`untrusted_*\` field contains a fenced copy. Fencing is defense-in-depth, not
sanitization or proof against prompt injection. Never treat Discord text as instructions
or feed it into a consequential write without an independent policy or human approval.
`
    : ''
}

## Source

[\`${sourceRelative}\`](${ghUrl})

${related ? `## Related tools\n\n${related}` : ''}
`;
}

// ---------------------------------------------------------------------------
// Index renderers
// ---------------------------------------------------------------------------

function titleCaseCategory(category: string): string {
  return category.charAt(0).toUpperCase() + category.slice(1).replace(/[_-]/g, ' ');
}

export function renderCategoryIndex(category: string, tools: ToolMetadata[]): string {
  const title = titleCaseCategory(category);
  const summaries = tools.map((tool) => {
    const slug = tool.name.startsWith(`${category}_`)
      ? tool.name.slice(category.length + 1)
      : tool.name;
    return {
      name: tool.name,
      category,
      summary: stripInlineMarkdown(parseDescription(tool.description).purpose),
      href: `/discord-mcp/tools/${category}/${slug}/`,
      destructive: Boolean(tool.annotations.destructiveHint),
      readOnly: Boolean(tool.annotations.readOnlyHint),
    };
  });

  return `---
title: ${title}
description: Browse and filter the ${tools.length} ${title.toLowerCase()} tools exposed by discord-mcp.
type: reference
sidebar:
  hidden: true
prev: false
next: false
---

import ToolCatalog from '../../../../components/docs/ToolCatalog.astro';

Use the technical identifier shown in each result as the MCP tool name. Open a tool to inspect
its safety metadata, exact input and output schemas, implementation source, and related tools.

<ToolCatalog tools={${JSON.stringify(summaries)}} />
`;
}

export function renderToolsIndex(byCategory: Map<string, ToolMetadata[]>): string {
  const total = Array.from(byCategory.values()).reduce((sum, arr) => sum + arr.length, 0);
  const domains = [
    {
      title: 'Messaging',
      description: 'Messages, channels, threads, reactions, polls, and webhooks.',
      categories: ['messages', 'channels', 'threads', 'reactions', 'polls', 'webhooks'],
    },
    {
      title: 'Moderation',
      description:
        'Members, roles, permission explanations, AutoMod, server settings, Guild Templates, invites, audit records, and onboarding.',
      categories: [
        'members',
        'roles',
        'permissions',
        'automod',
        'guild',
        'templates',
        'invites',
        'audit_log',
        'onboarding',
      ],
    },
    {
      title: 'Application',
      description:
        'App configuration, commands, interactions, Components V2, events, and intelligence.',
      categories: [
        'application',
        'commands',
        'interactions',
        'components_v2',
        'events',
        'intelligence',
      ],
    },
    {
      title: 'Experiences',
      description: 'Emoji, stickers, soundboard, voice, and Stage instances.',
      categories: ['emojis', 'app_emojis', 'stickers', 'soundboard', 'voice', 'stage_instances'],
    },
    {
      title: 'Inspiration',
      description:
        'Caller-invoked, read-only external asset discovery. These tools never change Discord by themselves.',
      categories: ['inspiration'],
    },
    {
      title: 'Monetization',
      description: 'Users, monetization, and protocol helpers.',
      categories: ['users', 'monetization', 'meta'],
    },
  ];
  const knownCategories = new Set(domains.flatMap((domain) => domain.categories));
  const ungrouped = [...byCategory.keys()].filter((category) => !knownCategories.has(category));
  if (ungrouped.length > 0) {
    throw new Error(`Tool categories need a domain: ${ungrouped.join(', ')}`);
  }

  const sections = domains
    .map(({ title, description, categories }) => {
      const cards = categories
        .flatMap((category) => {
          const tools = byCategory.get(category);
          if (!tools) return [];
          return [
            `  <LinkCard title="${titleCaseCategory(category)} (${tools.length})" href="/discord-mcp/tools/${category}/" />`,
          ];
        })
        .join('\n');
      if (!cards) return '';
      return `## ${title}\n\n${description}\n\n<CardGrid>\n${cards}\n</CardGrid>`;
    })
    .filter(Boolean)
    .join('\n\n');

  return `---
title: Tools
description: Find the discord-mcp contract you need by Discord domain, then narrow within its category.
type: reference
sidebar:
  order: 0
prev: false
next: false
---

import { LinkCard, CardGrid } from '@astrojs/starlight/components';

discord-mcp exposes ${total} tools across ${byCategory.size} categories. Start with the Discord
domain closest to your task, then use its focused category page to find the exact contract. Use
site search (<kbd>Ctrl</kbd> + <kbd>K</kbd>) when you already know an identifier.

:::caution
**Writes to Discord are not automatically safe.** Check the badges on each tool. Only tools
marked **Confirmation required** participate in the \`__confirm\` and dry-run gate; ordinary
writes can execute on the first call.
:::

${sections}
`;
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export interface GenerateOptions {
  toolsDir?: string;
  outDir?: string;
  /** Hard floor for sanity check; build fails if fewer tools load. */
  minTools?: number;
}

export async function generate(opts: GenerateOptions = {}): Promise<{
  tools: ToolMetadata[];
  filesWritten: number;
}> {
  const toolsDir = opts.toolsDir ?? TOOLS_DIR;
  const outDir = opts.outDir ?? OUT_DIR;
  const minTools = opts.minTools ?? 190;

  console.log('[generate-tool-docs] start');

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  const tools = await loadAllTools(toolsDir);
  console.log(`[generate-tool-docs] loaded ${tools.length} tools`);

  if (tools.length < minTools) {
    console.error(`[generate-tool-docs] FATAL: expected >= ${minTools} tools, got ${tools.length}`);
    process.exit(1);
  }

  // Group by category, sort tools alphabetically within each category
  const byCategory = new Map<string, ToolMetadata[]>();
  for (const t of tools) {
    if (!byCategory.has(t.category)) byCategory.set(t.category, []);
    byCategory.get(t.category)!.push(t);
  }
  for (const arr of byCategory.values()) {
    arr.sort((a, b) => a.name.localeCompare(b.name));
  }

  let written = 0;

  for (const tool of tools) {
    const dir = join(outDir, tool.category);
    mkdirSync(dir, { recursive: true });
    const slug = tool.name.startsWith(`${tool.category}_`)
      ? tool.name.slice(tool.category.length + 1)
      : tool.name;
    writeFileSync(
      join(dir, `${slug}.mdx`),
      renderToolMdx(tool, byCategory.get(tool.category) ?? []),
      'utf8',
    );
    written++;
  }
  console.log(`[generate-tool-docs] wrote ${written} tool pages`);

  for (const [category, list] of byCategory) {
    writeFileSync(join(outDir, category, 'index.mdx'), renderCategoryIndex(category, list), 'utf8');
    written++;
  }
  console.log(`[generate-tool-docs] wrote ${byCategory.size} category indexes`);

  writeFileSync(join(outDir, 'index.mdx'), renderToolsIndex(byCategory), 'utf8');
  written++;
  console.log('[generate-tool-docs] wrote top-level index');

  console.log(`[generate-tool-docs] done - ${written} files total`);

  return { tools, filesWritten: written };
}

async function main() {
  await generate();
}

const invokedAsMain = (() => {
  if (!process.argv[1]) return false;
  try {
    const argvUrl = new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href;
    return import.meta.url === argvUrl;
  } catch {
    return false;
  }
})();

if (invokedAsMain) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
