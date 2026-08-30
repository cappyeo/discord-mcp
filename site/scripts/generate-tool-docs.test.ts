import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from '../../packages/mcp-core/node_modules/zod/index.js';
import {
  buildOutputExample,
  buildSchemaExample,
  escapeMdx,
  escapeMdxProse,
  generate,
  loadAllTools,
  parseDescription,
  renderCategoryIndex,
  renderJsonSchema,
  renderSchemaTable,
  renderToolMdx,
  renderToolsIndex,
  type ToolMetadata,
} from './generate-tool-docs.js';

const sampleDesc = [
  '**Purpose**: Send a plain text message to a channel.',
  '',
  '**When to use**:',
  '- Quick notification or response.',
  '- Avoid for components.',
  '',
  '**When NOT to use**:',
  '- Embeds - use rich_send instead.',
  '',
  '**Returns**: `{message_id, channel_id}`.',
].join('\n');

describe('parseDescription', () => {
  it('splits a complete 4-section description', () => {
    const out = parseDescription(sampleDesc);
    expect(out.purpose).toBe('Send a plain text message to a channel.');
    expect(out.whenToUse).toContain('Quick notification');
    expect(out.whenToUse).toContain('Avoid for components.');
    expect(out.whenNotToUse).toContain('Embeds - use rich_send');
    expect(out.returns).toContain('message_id');
    expect(out.extraSections).toEqual([]);
  });

  it('returns empty strings for missing sections', () => {
    const out = parseDescription('**Purpose**: only purpose here.');
    expect(out.purpose).toBe('only purpose here.');
    expect(out.whenToUse).toBe('');
    expect(out.whenNotToUse).toBe('');
    expect(out.returns).toBe('');
    expect(out.extraSections).toEqual([]);
  });

  it('preserves authored sections such as Example', () => {
    const desc = ['**Purpose**: do thing.', '', '**Example**: x.', '', '**Returns**: `{ok}`.'].join(
      '\n',
    );
    const out = parseDescription(desc);
    expect(out.purpose).toBe('do thing.');
    expect(out.returns).toContain('ok');
    expect(out.extraSections).toEqual([{ heading: 'Example', body: 'x.' }]);
  });

  it('returns empty record for non-conforming input', () => {
    const out = parseDescription('totally unstructured text');
    expect(out).toEqual({
      purpose: '',
      whenToUse: '',
      whenNotToUse: '',
      returns: '',
      extraSections: [],
    });
  });
});

describe('escapeMdx', () => {
  it('escapes < to \\<', () => {
    expect(escapeMdx('<channel_id>')).toBe('\\<channel_id>');
  });

  it('escapes { and } so JSX expressions render as text', () => {
    expect(escapeMdx('{key:value}')).toBe('\\{key:value\\}');
  });

  it('leaves regular text untouched', () => {
    expect(escapeMdx('plain text 123')).toBe('plain text 123');
  });

  it('preserves braces inside inline code while escaping prose braces', () => {
    expect(escapeMdxProse('Returns `{message_id}` from {Discord}.')).toBe(
      'Returns `{message_id}` from \\{Discord\\}.',
    );
  });
});

describe('renderSchemaTable', () => {
  it('returns a placeholder when there are no fields', () => {
    expect(renderSchemaTable({})).toBe('*(no fields)*');
    expect(renderSchemaTable(undefined)).toBe('*(no fields)*');
  });

  it('renders primitive fields with required + description', () => {
    const md = renderSchemaTable({
      channel_id: z.string().describe('Channel snowflake'),
      content: z.string(),
    });
    expect(md).toContain('| Field | Type | Required | Constraints | Description |');
    expect(md).toContain('`channel_id`');
    expect(md).toContain('Channel snowflake');
    expect(md).toContain('| yes |');
  });

  it('marks optional fields as not required', () => {
    const md = renderSchemaTable({
      content: z.string(),
      flags: z.number().int().optional().describe('bitflags'),
    });
    expect(md).toMatch(/`flags`.*\|\s*no\s*\|/);
    expect(md).toMatch(/`content`.*\|\s*yes\s*\|/);
  });

  it('handles array fields', () => {
    const md = renderSchemaTable({
      ids: z.array(z.string()).describe('list of ids'),
    });
    expect(md).toContain('`ids`');
    expect(md).toContain('array');
    expect(md).toContain('list of ids');
  });

  it('marks defaulted fields as optional at the call boundary', () => {
    const md = renderSchemaTable({ limit: z.number().int().default(50) });
    expect(md).toMatch(/`limit`.*\|\s*no\s*\|/);
    expect(md).toContain('default: `50`');
  });

  it('uses the complete JSON Schema required list for z.unknown outputs', () => {
    const md = renderSchemaTable({ component: z.unknown() });
    expect(md).toMatch(/`component`.*\|\s*yes\s*\|/);
  });

  it('renders the complete JSON schema for nested inspection', () => {
    const schema = renderJsonSchema({ options: z.array(z.object({ label: z.string() })) });
    expect(schema).toContain('"options"');
    expect(schema).toContain('"label"');
  });

  it('removes implementation sentinel bounds from the published JSON Schema', () => {
    expect(renderJsonSchema({ count: z.number().int() })).not.toContain('9007199254740991');
  });

  it('publishes input-mode schemas where defaulted fields are optional', () => {
    const schema = JSON.parse(renderJsonSchema({ limit: z.number().int().default(50) })) as {
      required?: string[];
    };
    expect(schema.required ?? []).not.toContain('limit');
  });
});

describe('buildSchemaExample', () => {
  it('prefers digest patterns over the generic _id Snowflake heuristic', () => {
    const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);

    expect(buildSchemaExample({ approval_id: digest })).toEqual({
      approval_id: `sha256:${'0'.repeat(64)}`,
    });
  });

  it('builds a schema-valid example from required fields and skips optionals', () => {
    const fields = {
      channel_id: z.string().regex(/^\d{17,20}$/),
      content: z.string().min(1).max(2000),
      tts: z.boolean().optional(),
    };
    const example = buildSchemaExample(fields);
    expect(example).toEqual({
      channel_id: '123456789012345678',
      content: 'Hello from discord-mcp',
    });
    expect(z.object(fields).safeParse(example).success).toBe(true);
  });

  it('builds nested object and array examples', () => {
    const fields = {
      items: z.array(z.object({ url: z.url(), label: z.string() })).min(1),
    };
    const example = buildSchemaExample(fields);
    expect(z.object(fields).safeParse(example).success).toBe(true);
  });

  it('avoids implementation-level safe-integer bounds as sample values', () => {
    expect(buildSchemaExample({ count: z.number().int() })).toEqual({ count: 1 });
    expect(renderSchemaTable({ count: z.number().int() })).not.toContain('9007199254740991');
  });

  it('creates a semantically complete voice scheduled-event example', () => {
    const fields = {
      guild_id: z.string(),
      entity_type: z.union([z.literal(1), z.literal(2), z.literal(3)]),
      channel_id: z.string().optional(),
      scheduled_start_time: z.iso.datetime(),
    };
    expect(buildSchemaExample(fields, { toolName: 'events_create' })).toEqual({
      guild_id: '123456789012345678',
      entity_type: 2,
      channel_id: '123456789012345678',
      scheduled_start_time: '2030-01-01T10:00:00.000Z',
    });
  });

  it('uses a valid TextDisplay child for Components V2 array inputs', () => {
    const fields = { components: z.array(z.unknown()).min(1) };
    expect(buildSchemaExample(fields, { toolName: 'components_v2_validate' })).toEqual({
      components: [{ type: 10, content: 'Hello from discord-mcp' }],
    });
  });

  it('fills Discord cross-field requirements in command, forum, and upload examples', () => {
    const command = buildSchemaExample(
      {
        application_id: z.string(),
        name: z.string(),
        description: z.string().optional(),
        type: z.number().int().optional(),
      },
      { toolName: 'commands_create_global' },
    );
    expect(command).toMatchObject({ type: 1, description: 'Example command description' });

    const forum = buildSchemaExample(
      { message: z.object({ content: z.string().optional() }) },
      { toolName: 'channels_forum_create_thread' },
    );
    expect(forum).toEqual({ message: { content: 'Hello from discord-mcp' } });

    expect(buildSchemaExample({ image: z.string().describe('Base64 data URI') })).toEqual({
      image: 'data:image/png;base64,iVBORw0KGgo=',
    });
  });

  it('uses a real registered tool in the pipeline example', () => {
    const example = buildSchemaExample(
      {
        steps: z.array(
          z.object({
            id: z.string().optional(),
            tool: z.string(),
            args: z.record(z.string(), z.unknown()),
          }),
        ),
      },
      { toolName: 'mcp_pipeline' },
    );
    expect(example).toEqual({ steps: [{ id: 'me', tool: 'users_get_current', args: {} }] });
  });

  it('adds one useful mutable field to modify calls without required changes', () => {
    expect(
      buildSchemaExample(
        {
          guild_id: z.string(),
          audit_reason: z.string().optional(),
          name: z.string().optional(),
          topic: z.string().optional(),
        },
        { toolName: 'channels_modify' },
      ),
    ).toEqual({ guild_id: '123456789012345678', name: 'Example name' });
  });

  it('uses the preferred local plan reference for blueprint apply examples', () => {
    const example = buildSchemaExample(
      {
        guild_id: z.string(),
        expected_bot_id: z.string(),
        plan_ref: z.string().optional(),
        plan_token: z.string().optional(),
        approval_id: z.string(),
      },
      { toolName: 'guild_blueprint_apply' },
    );
    expect(example).toMatchObject({ plan_ref: `dmbpr1.${'f'.repeat(64)}` });
    expect(example).not.toHaveProperty('plan_token');
  });
});

describe('renderToolMdx', () => {
  const sampleTool: ToolMetadata = {
    name: 'messages_send',
    category: 'messages',
    description: sampleDesc,
    inputSchema: {
      channel_id: z.string().describe('Target channel'),
      content: z.string().describe('Plain text body'),
    },
    outputSchema: { message_id: z.string(), channel_id: z.string() },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    idempotent: false,
    preconditions: [],
    sourcePath: join(
      'C:',
      'Users',
      'jeong',
      'project',
      'discord-mcp',
      '.worktrees',
      'plan10-docs-site',
      'packages',
      'mcp-core',
      'src',
      'tools',
      'messages',
      'send.ts',
    ),
  };

  it('produces frontmatter with quoted description', () => {
    const mdx = renderToolMdx(sampleTool);
    expect(mdx).toMatch(/^---\ntitle: messages_send\ndescription: '/);
    expect(mdx).toContain('sidebar:\n  hidden: true');
    expect(mdx).toContain('editUrl: https://github.com/cappyeo/discord-mcp/edit/main/');
  });

  it('relies on Starlight for the page H1 and includes populated content sections + tables', () => {
    const mdx = renderToolMdx(sampleTool);
    expect(mdx).toContain('title: messages_send');
    expect(mdx).not.toMatch(/^# /m);
    expect(mdx).toContain('## When to use');
    expect(mdx).toContain('## When not to use');
    expect(mdx).toContain('## Input');
    expect(mdx).toContain('## Returns');
    expect(mdx).toContain('### Output schema');
    expect(mdx).toContain('## Annotations');
    expect(mdx).toContain('## Source');
    expect(mdx).toContain('Complete input JSON Schema');
    expect(mdx).toContain('## MCP call example');
    expect(mdx).toContain('### Example structured result');
    expect(mdx).toContain('## Access and common errors');
  });

  it('renders confirm_required precondition when present', () => {
    const mdx = renderToolMdx({ ...sampleTool, preconditions: ['confirm_required'] });
    expect(mdx).toContain('__confirm:true');
  });

  it('renders the blueprint apply credential XOR contract and ref example', () => {
    const mdx = renderToolMdx({
      ...sampleTool,
      name: 'guild_blueprint_apply',
      category: 'guild',
      description: '**Purpose**: Apply an approved blueprint.',
      inputSchema: {
        guild_id: z.string(),
        expected_bot_id: z.string(),
        plan_ref: z.string().optional(),
        plan_token: z.string().optional(),
        approval_id: z.string(),
      },
      preconditions: ['confirm_required'],
    });
    expect(mdx).toContain('"oneOf": [');
    expect(mdx).toContain('"plan_ref": "dmbpr1.');
    expect(mdx).not.toContain('"plan_token": "REPLACE_WITH_TOKEN"');
  });

  it('describes local-only tools without Discord permission boilerplate', () => {
    const mdx = renderToolMdx({
      ...sampleTool,
      annotations: { ...sampleTool.annotations, openWorldHint: false },
    });
    expect(mdx).toContain('This tool is local-only and does not call Discord.');
    expect(mdx).not.toContain("Discord applies the bot's server role");
  });

  it('uses one real output branch for alternative and unknown schemas', () => {
    const webhook = buildOutputExample({
      ...sampleTool,
      name: 'webhooks_execute',
      category: 'webhooks',
      outputSchema: {
        enqueued: z.boolean().optional(),
        message_id: z.string().optional(),
      },
    });
    expect(webhook).toEqual({ enqueued: true });

    const builder = buildOutputExample({
      ...sampleTool,
      name: 'components_v2_build_container',
      category: 'components_v2',
      outputSchema: { component: z.unknown() },
    });
    expect(builder?.component).toMatchObject({ type: 17 });
  });

  it('folds an authored shorthand into the runnable MCP example', () => {
    const mdx = renderToolMdx({
      ...sampleTool,
      description: `${sampleDesc}\n\n**Example**: \`{channel_id:"123"}\`.`,
    });
    expect(mdx).toContain('**Tool-authored shorthand:**');
    expect(mdx).not.toMatch(/^## Example$/m);
    expect(mdx).toContain('## MCP call example');
  });

  it('renders a fenced authored example without nesting a broken fence in a blockquote', () => {
    const mdx = renderToolMdx({
      ...sampleTool,
      description: `${sampleDesc}\n\n**Example**:\n\`\`\`json\n{"channel_id":"123"}\n\`\`\``,
    });
    expect(mdx).toContain('**Tool-authored example**\n\n```json');
    expect(mdx).not.toContain('> **Tool-authored shorthand:** ```');
  });
});

describe('renderCategoryIndex', () => {
  it('produces a searchable catalog with one entry per tool', () => {
    const tools: ToolMetadata[] = [
      {
        name: 'messages_a',
        category: 'messages',
        description: '**Purpose**: A.',
        inputSchema: {},
        outputSchema: undefined,
        annotations: {},
        idempotent: false,
        preconditions: [],
        sourcePath: 'a',
      },
      {
        name: 'messages_b',
        category: 'messages',
        description: '**Purpose**: B with "quotes" & <brackets>.',
        inputSchema: {},
        outputSchema: undefined,
        annotations: {},
        idempotent: false,
        preconditions: [],
        sourcePath: 'b',
      },
    ];
    const md = renderCategoryIndex('messages', tools);
    expect(md).toContain('title: Messages');
    expect(md).not.toMatch(/^# /m);
    expect(md).toContain('ToolCatalog');
    expect(md).toContain('messages_a');
    expect(md).toContain('messages_b');
    expect(md).not.toContain('**Purpose**');
    expect(md).toContain('B with \\"quotes\\" & <brackets>.');
  });
});

describe('renderToolsIndex', () => {
  it('summarizes total + per-category counts', () => {
    const byCat = new Map<string, ToolMetadata[]>([
      [
        'messages',
        [
          {
            name: 'messages_a',
            category: 'messages',
            description: '',
            inputSchema: {},
            outputSchema: undefined,
            annotations: {},
            idempotent: false,
            preconditions: [],
            sourcePath: '',
          },
        ],
      ],
      [
        'channels',
        [
          {
            name: 'channels_a',
            category: 'channels',
            description: '',
            inputSchema: {},
            outputSchema: undefined,
            annotations: {},
            idempotent: false,
            preconditions: [],
            sourcePath: '',
          },
        ],
      ],
    ]);
    const md = renderToolsIndex(byCat);
    expect(md).toContain('title: Tools');
    expect(md).toContain('discord-mcp exposes 2 tools');
    expect(md).not.toMatch(/^# /m);
    expect(md).toContain('Messages (1)');
    expect(md).not.toContain('ToolCatalog');
    expect(md).toContain('Channels (1)');
    expect(md).toContain('Messaging');
  });
});

describe('loadAllTools', () => {
  let fixtureDir: string;

  beforeEach(() => {
    fixtureDir = join(tmpdir(), `discord-mcp-fixture-${Date.now()}`);
    mkdirSync(join(fixtureDir, 'messages'), { recursive: true });
    mkdirSync(join(fixtureDir, '_lib'), { recursive: true });

    // Tool with metadata
    const toolSrc = `
      const tool = {};
      Object.assign(tool, {
        __toolMetadata: {
          name: 'messages_smoke',
          category: 'messages',
          description: '**Purpose**: smoke.',
          inputSchema: {},
          outputSchema: undefined,
          annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
          idempotent: false,
          preconditions: [],
        },
      });
      export default tool;
    `;
    writeFileSync(join(fixtureDir, 'messages', 'smoke.ts'), toolSrc, 'utf8');

    // Test file (must be skipped)
    writeFileSync(join(fixtureDir, 'messages', 'smoke.test.ts'), 'export default {};', 'utf8');

    // _lib file (must be skipped)
    writeFileSync(join(fixtureDir, '_lib', 'helpers.ts'), 'export const x = 1;', 'utf8');
  });

  afterEach(() => {
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  it('discovers tool modules with __toolMetadata, skips _lib and *.test.ts', async () => {
    const tools = await loadAllTools(fixtureDir);
    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe('messages_smoke');
    expect(tools[0]?.category).toBe('messages');
  });
});

describe('generate (smoke)', () => {
  let fixtureDir: string;
  let outDir: string;

  beforeEach(() => {
    const stamp = Date.now();
    fixtureDir = join(tmpdir(), `discord-mcp-gen-fixture-${stamp}`);
    outDir = join(tmpdir(), `discord-mcp-gen-out-${stamp}`);
    mkdirSync(join(fixtureDir, 'messages'), { recursive: true });
    mkdirSync(join(fixtureDir, 'channels'), { recursive: true });

    const buildTool = (name: string, category: string) => `
      const tool = {};
      Object.assign(tool, {
        __toolMetadata: {
          name: '${name}',
          category: '${category}',
          description: '**Purpose**: ${name} purpose.\\n**When to use**:\\n- always.\\n**When NOT to use**:\\n- never.\\n**Returns**: \`{ok}\`.',
          inputSchema: {},
          outputSchema: undefined,
          annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
          idempotent: false,
          preconditions: [],
        },
      });
      export default tool;
    `;
    writeFileSync(
      join(fixtureDir, 'messages', 'send.ts'),
      buildTool('messages_send', 'messages'),
      'utf8',
    );
    writeFileSync(
      join(fixtureDir, 'messages', 'read.ts'),
      buildTool('messages_read', 'messages'),
      'utf8',
    );
    writeFileSync(
      join(fixtureDir, 'channels', 'list.ts'),
      buildTool('channels_list', 'channels'),
      'utf8',
    );
  });

  afterEach(() => {
    rmSync(fixtureDir, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  });

  it('produces tool pages + per-category indexes + top-level index', async () => {
    const result = await generate({ toolsDir: fixtureDir, outDir, minTools: 3 });
    expect(result.tools).toHaveLength(3);
    expect(result.filesWritten).toBe(3 + 2 + 1); // 3 tools + 2 cat indexes + 1 top index

    const files = readdirSync(join(outDir));
    expect(files).toContain('index.mdx');
    expect(files).toContain('messages');
    expect(files).toContain('channels');

    const messageFiles = readdirSync(join(outDir, 'messages'));
    expect(messageFiles).toContain('send.mdx');
    expect(messageFiles).toContain('read.mdx');
    expect(messageFiles).toContain('index.mdx');

    const topIndex = readFileSync(join(outDir, 'index.mdx'), 'utf8');
    expect(topIndex).toContain('title: Tools');
    expect(topIndex).toContain('discord-mcp exposes 3 tools');
    expect(topIndex).not.toMatch(/^# /m);
  });
});
