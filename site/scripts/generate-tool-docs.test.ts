import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from '../../packages/mcp-core/node_modules/zod/index.js';
import {
  escapeMdx,
  generate,
  loadAllTools,
  parseDescription,
  renderCategoryIndex,
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
  '- Embeds — use rich_send instead.',
  '',
  '**Returns**: `{message_id, channel_id}`.',
].join('\n');

describe('parseDescription', () => {
  it('splits a complete 4-section description', () => {
    const out = parseDescription(sampleDesc);
    expect(out.purpose).toBe('Send a plain text message to a channel.');
    expect(out.whenToUse).toContain('Quick notification');
    expect(out.whenToUse).toContain('Avoid for components.');
    expect(out.whenNotToUse).toContain('Embeds — use rich_send');
    expect(out.returns).toContain('message_id');
  });

  it('returns empty strings for missing sections', () => {
    const out = parseDescription('**Purpose**: only purpose here.');
    expect(out.purpose).toBe('only purpose here.');
    expect(out.whenToUse).toBe('');
    expect(out.whenNotToUse).toBe('');
    expect(out.returns).toBe('');
  });

  it('ignores unknown sections (e.g. Example)', () => {
    const desc = ['**Purpose**: do thing.', '', '**Example**: x.', '', '**Returns**: `{ok}`.'].join(
      '\n',
    );
    const out = parseDescription(desc);
    expect(out.purpose).toBe('do thing.');
    expect(out.returns).toContain('ok');
  });

  it('returns empty record for non-conforming input', () => {
    const out = parseDescription('totally unstructured text');
    expect(out).toEqual({ purpose: '', whenToUse: '', whenNotToUse: '', returns: '' });
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
    expect(md).toContain('| Field | Type | Required | Description |');
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
  });

  it('relies on Starlight for the page H1 and includes all four content sections + tables', () => {
    const mdx = renderToolMdx(sampleTool);
    expect(mdx).toContain('title: messages_send');
    expect(mdx).not.toMatch(/^# /m);
    expect(mdx).toContain('## When to use');
    expect(mdx).toContain('## When NOT to use');
    expect(mdx).toContain('## Input');
    expect(mdx).toContain('## Returns');
    expect(mdx).toContain('### Output schema');
    expect(mdx).toContain('## Annotations');
    expect(mdx).toContain('## Source');
  });

  it('renders confirm_required precondition when present', () => {
    const mdx = renderToolMdx({ ...sampleTool, preconditions: ['confirm_required'] });
    expect(mdx).toContain('__confirm:true');
  });
});

describe('renderCategoryIndex', () => {
  it('produces a CardGrid with one card per tool, alphabetical by name', () => {
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
    expect(md).toContain('2 tools in this category');
    expect(md).toContain('messages_a');
    expect(md).toContain('messages_b');
    // JSX attribute values must be HTML-encoded, not backslash-escaped.
    expect(md).toContain('&quot;quotes&quot;');
    expect(md).toContain('&lt;brackets>');
    expect(md).toContain('&amp;');
    expect(md).not.toContain('\\"quotes\\"');
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
    expect(md).toContain('Channels (1)');
    // Categories sorted alphabetically (channels before messages)
    const idxChannels = md.indexOf('Channels (1)');
    const idxMessages = md.indexOf('Messages (1)');
    expect(idxChannels).toBeLessThan(idxMessages);
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
