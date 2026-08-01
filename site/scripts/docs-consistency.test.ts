/**
 * Drift guard: the confirmation architecture page must enumerate exactly the
 * tools that actually carry the `confirm_required` precondition.
 *
 * This page documents the product's load-bearing safety primitive. It drifted
 * for twelve releases claiming "roughly 70 tools" gated by `idempotent: false`
 * while the real mechanism is an explicit per-tool opt-in covering 29. An
 * operator reading the stale copy would ship believing nothing could mutate
 * Discord without confirmation.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from '../../packages/mcp-core/node_modules/zod/index.js';
import {
  buildOutputExample,
  buildSchemaExample,
  loadAllTools,
  parseDescription,
  renderToolMdx,
} from './generate-tool-docs.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(__dirname, '../..');
const DOCS_DIR = join(ROOT, 'site/src/content/docs');
const CONFIRMATION_MDX = join(ROOT, 'site/src/content/docs/architecture/confirmation.mdx');

/** Backticked snake_case identifiers, e.g. `messages_delete`. */
const BACKTICKED = /`([a-z][a-z0-9]*(?:_[a-z0-9]+)+)`/g;

function collectMdxFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return collectMdxFiles(path);
    return entry.name.endsWith('.mdx') ? [path] : [];
  });
}

function routeForMdx(file: string): string {
  const relativePath = relative(DOCS_DIR, file)
    .replace(/\\/g, '/')
    .replace(/\.mdx$/, '');
  const slug = relativePath === 'index' ? '' : relativePath.replace(/\/index$/, '');
  return `/discord-mcp/${slug ? `${slug}/` : ''}`;
}

describe('confirmation.mdx enumerates the real confirm-gated tool set', () => {
  it('lists exactly the tools whose metadata declares confirm_required', async () => {
    const tools = await loadAllTools();
    const gated = new Set(
      tools.filter((t) => t.preconditions.includes('confirm_required')).map((t) => t.name),
    );
    expect(gated.size).toBeGreaterThan(0);

    const mdx = readFileSync(CONFIRMATION_MDX, 'utf8');

    // The roll-up table is the enumeration under test. Slice from its heading
    // to the next heading so prose elsewhere on the page can't satisfy it.
    const start = mdx.indexOf('## Which tools require it');
    expect(start, 'confirmation.mdx must keep a "Which tools require it" section').toBeGreaterThan(
      -1,
    );
    const rest = mdx.slice(start + 1);
    const end = rest.indexOf('\n## ');
    const section = end === -1 ? rest : rest.slice(0, end);

    const registered = new Set(tools.map((t) => t.name));
    const mentioned = new Set<string>();
    for (const m of section.matchAll(BACKTICKED)) {
      const name = m[1]!;
      // The section also names non-gated tools in the "NOT gated" callout and
      // refers to the precondition id itself. Only registered tool names count.
      if (registered.has(name)) mentioned.add(name);
    }

    // Every gated tool must appear.
    const missing = [...gated].filter((n) => !mentioned.has(n)).sort();
    expect(missing, 'gated tools missing from confirmation.mdx').toEqual([]);

    // The "NOT gated" callout deliberately names ungated tools, so we cannot
    // assert set equality over the whole section. Assert it over the table.
    const tableRows = section
      .split('\n')
      .filter((l) => l.startsWith('|') && !l.includes('---') && !l.includes('Gated tools'));
    const inTable = new Set<string>();
    for (const row of tableRows) {
      for (const m of row.matchAll(BACKTICKED)) {
        if (registered.has(m[1]!)) inTable.add(m[1]!);
      }
    }
    expect([...inTable].sort(), 'confirmation.mdx table vs registry').toEqual([...gated].sort());
  });

  it('states the gated count as a number matching the registry', async () => {
    const tools = await loadAllTools();
    const count = tools.filter((t) => t.preconditions.includes('confirm_required')).length;
    const mdx = readFileSync(CONFIRMATION_MDX, 'utf8');
    expect(
      mdx.includes(`**${count} tools**`),
      `confirmation.mdx must state "**${count} tools**" (registry has ${count} confirm-gated tools)`,
    ).toBe(true);
  });

  it('does not resurrect the inverted "idempotent: false is the source of truth" claim', () => {
    const mdx = readFileSync(CONFIRMATION_MDX, 'utf8');
    expect(mdx).not.toMatch(/idempotent:\s*false.{0,80}source of truth/is);
    expect(mdx).not.toMatch(/Every tool with `idempotent: false`/);
  });

  it('names the mutating tools that are NOT gated, so operators are not surprised', async () => {
    const tools = await loadAllTools();
    const registered = new Set(tools.map((t) => t.name));
    const gated = new Set(
      tools.filter((t) => t.preconditions.includes('confirm_required')).map((t) => t.name),
    );
    const mdx = readFileSync(CONFIRMATION_MDX, 'utf8');

    const mustWarnAbout = [
      'messages_send',
      'messages_edit',
      'channels_create_guild_channel',
      'webhooks_execute',
      'roles_create',
      'members_add_role',
      'components_v2_send',
    ];
    for (const name of mustWarnAbout) {
      // Guard the guard: if one of these ever becomes gated, this list is stale.
      expect(registered.has(name), `${name} should be a registered tool`).toBe(true);
      expect(gated.has(name), `${name} is now gated - update the NOT-gated callout`).toBe(false);
      expect(mdx.includes(`\`${name}\``), `confirmation.mdx must name \`${name}\``).toBe(true);
    }
  });
});

describe('generated reference stays aligned with tool metadata', () => {
  it('renders a complete, source-linked reference page for every registered tool', async () => {
    const tools = await loadAllTools();
    expect(tools.length).toBeGreaterThan(0);

    for (const tool of tools) {
      const rendered = renderToolMdx(tool);
      const description = parseDescription(tool.description);

      expect(rendered, `${tool.name}: leaf pages must stay out of the global sidebar`).toContain(
        'sidebar:\n  hidden: true',
      );
      expect(rendered, `${tool.name}: source edit link`).toContain(
        'editUrl: https://github.com/cappyeo/discord-mcp/edit/main/',
      );
      expect(rendered, `${tool.name}: runnable call example`).toContain('## MCP call example');
      expect(rendered, `${tool.name}: structured result example`).toContain(
        '### Example structured result',
      );
      expect(rendered, `${tool.name}: access/error guidance`).toContain(
        '## Access and common errors',
      );

      const requiresConfirm = tool.preconditions.includes('confirm_required');
      expect(
        rendered.includes('| `__confirm` |'),
        `${tool.name}: rendered table must match runtime confirmation schema`,
      ).toBe(requiresConfirm);
      expect(
        rendered.includes('"__confirm": true'),
        `${tool.name}: executable call must match runtime confirmation contract`,
      ).toBe(requiresConfirm);

      const inputExample = buildSchemaExample(tool.inputSchema, { toolName: tool.name });
      expect(inputExample, `${tool.name}: input example`).toBeDefined();
      expect(
        z.object(tool.inputSchema).safeParse(inputExample).success,
        `${tool.name}: generated input example must satisfy its Zod schema`,
      ).toBe(true);

      if (tool.outputSchema) {
        const outputExample = buildOutputExample(tool);
        expect(outputExample, `${tool.name}: output example`).toBeDefined();
        expect(
          z.object(tool.outputSchema).safeParse(outputExample).success,
          `${tool.name}: generated output example must satisfy its Zod schema`,
        ).toBe(true);
      }

      expect(
        JSON.stringify(inputExample),
        `${tool.name}: no safe-integer sentinel examples`,
      ).not.toContain('9007199254740991');
      if (tool.outputSchema) {
        expect(
          JSON.stringify(buildOutputExample(tool)),
          `${tool.name}: no empty result example`,
        ).not.toBe('{}');
      }

      if (!description.whenToUse) expect(rendered).not.toContain('## When to use');
      if (!description.whenNotToUse) expect(rendered).not.toContain('## When not to use');
      for (const section of description.extraSections) {
        if (section.heading.toLowerCase() === 'example') {
          expect(
            rendered.includes('**Tool-authored shorthand:**') ||
              rendered.includes('**Tool-authored example**'),
            `${tool.name}: preserve authored example`,
          ).toBe(true);
        } else {
          expect(rendered, `${tool.name}: preserve authored ${section.heading} section`).toContain(
            `## ${section.heading}`,
          );
        }
      }
    }
  });

  it('keeps homepage inventory numbers tied to the registry', async () => {
    const tools = await loadAllTools();
    const categories = new Set(tools.map((tool) => tool.category));
    const homepage = readFileSync(join(DOCS_DIR, 'index.mdx'), 'utf8');

    expect(homepage).toContain(`${tools.length} tools`);
    expect(homepage).toContain(`${categories.size} categories`);
  });

  it('keeps Discord cross-field examples useful, not only Zod-valid', async () => {
    const tools = await loadAllTools();
    const examples = new Map(
      tools.map((tool) => [
        tool.name,
        buildSchemaExample(tool.inputSchema, { toolName: tool.name }) ?? {},
      ]),
    );

    for (const name of ['commands_create_global', 'commands_create_guild']) {
      expect(examples.get(name), name).toMatchObject({
        type: 1,
        description: 'Example command description',
      });
    }
    for (const name of ['commands_bulk_overwrite_global', 'commands_bulk_overwrite_guild']) {
      expect(examples.get(name), name).toMatchObject({
        commands: [{ type: 1, description: 'Example command description' }],
      });
    }
    for (const name of ['app_emojis_create', 'emojis_create']) {
      expect(examples.get(name), name).toMatchObject({
        image: expect.stringMatching(/^data:image\/png;base64,/),
      });
    }

    expect(examples.get('channels_forum_create_thread')).toMatchObject({
      message: { content: expect.any(String) },
    });
    expect(examples.get('stickers_create_guild_sticker')).toMatchObject({
      file_format: 1,
      file_data: expect.stringMatching(/^data:image\/png;base64,/),
    });
    expect(examples.get('commands_edit_command_permissions')).toMatchObject({
      bearer_token: 'REPLACE_WITH_USER_OAUTH_TOKEN',
    });
    expect(examples.get('mcp_pipeline')).toMatchObject({
      steps: [{ tool: 'users_get_current', args: {} }],
    });
    expect(examples.get('onboarding_modify')).toMatchObject({
      prompts: [],
      default_channel_ids: [],
      enabled: false,
      mode: 0,
    });
    expect(examples.get('roles_modify_positions')).toMatchObject({
      positions: [{ position: 1 }],
    });
    expect(examples.get('messages_bulk_delete')).toMatchObject({
      message_ids: ['123456789012345678', '123456789012345679'],
    });
    expect(examples.get('automod_create_rule')).toMatchObject({ trigger_type: 3 });
    expect(examples.get('channels_modify_permissions')).toMatchObject({ allow: '0' });
    expect(examples.get('intelligence_classify_messages')).toMatchObject({
      categories: ['support', 'spam'],
    });
    expect(examples.get('interactions_create_response')).toMatchObject({
      type: 4,
      data: { content: 'Hello from discord-mcp' },
    });
    expect(Date.parse(String(examples.get('events_create')?.scheduled_start_time))).toBeGreaterThan(
      Date.parse('2026-08-01T12:00:00.000Z'),
    );
  });

  it('gives every modify example one explicit mutation beyond identity and audit fields', async () => {
    const tools = await loadAllTools();
    const identityField = /(^|_)(id|token)$|^audit_reason$|^__confirm$/;

    for (const tool of tools.filter(({ name }) => name.includes('modify'))) {
      const example = buildSchemaExample(tool.inputSchema, { toolName: tool.name }) ?? {};
      expect(
        Object.keys(example).some((name) => !identityField.test(name)),
        `${tool.name}: example must perform a visible mutation`,
      ).toBe(true);
    }
  });

  it('does not claim bot-role authorization for anonymous or scoped-token routes', async () => {
    const tools = await loadAllTools();
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    const scoped = [
      'commands_edit_command_permissions',
      'interactions_create_response',
      'webhooks_execute',
      'guild_get_widget',
    ];

    for (const name of scoped) {
      const tool = byName.get(name);
      expect(tool, `${name}: registered`).toBeDefined();
      const access = renderToolMdx(tool!).split('## Access and common errors')[1];
      expect(access, `${name}: scoped auth guidance`).not.toContain("bot's server role");
    }

    expect(renderToolMdx(byName.get('commands_edit_command_permissions')!)).toContain(
      'user OAuth2 bearer token',
    );
    expect(renderToolMdx(byName.get('interactions_create_response')!)).toContain(
      'interaction token in the route',
    );
    expect(renderToolMdx(byName.get('webhooks_execute')!)).toContain('webhook token in the route');
    expect(renderToolMdx(byName.get('guild_get_widget')!)).toContain('public widget anonymously');
  });
});

describe('handwritten docs do not regress to known stale contracts', () => {
  it('classifies every section hub with the extended content schema', () => {
    for (const page of [
      'index.mdx',
      'start/index.mdx',
      'recipes/index.mdx',
      'operations/index.mdx',
      'migrate/index.mdx',
      'reference/index.mdx',
      'architecture/index.mdx',
    ]) {
      expect(readFileSync(join(DOCS_DIR, page), 'utf8'), page).toMatch(/^type: \w+$/m);
    }
  });

  it('matches the repository Node.js floor in both installation paths', () => {
    const packageJson = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
      engines: { node: string };
    };
    const nodeFloor = packageJson.engines.node.replace(/^>=/, '');

    for (const page of ['start/local-setup.mdx', 'start/installation.mdx']) {
      expect(readFileSync(join(DOCS_DIR, page), 'utf8'), page).toContain(nodeFloor);
    }
  });

  it('rejects retired names, commands, release-plan prose, and atomic pipeline claims', () => {
    const excluded = new Set([
      'reference/changelog.mdx',
      'operations/security-audit-2026-05-01.mdx',
      'operations/security-audit-2026-07-27.mdx',
    ]);
    const files = collectMdxFiles(DOCS_DIR).filter((file) => {
      const path = relative(DOCS_DIR, file).replace(/\\/g, '/');
      return !path.startsWith('tools/') && !excluded.has(path);
    });
    const forbidden: Array<[string, RegExp]> = [
      ['retired MCP_SCOPES variable', /\bMCP_SCOPES\b/],
      ['retired Node.js 20.11 floor', /Node(?:\.js)?\s+20\.11/i],
      ['unscoped npx command', /\bnpx\s+discord-mcp\b/],
      ['internal plan numbering', /\bPlan\s+\d+\b/],
      ['atomic pipeline promise', /\bis atomic\b|\batomic transaction\b|\ball-or-nothing\b/i],
      [
        'stale four-layer middleware contract',
        /four[- ]layer(?:ed)?\s+middleware|four\s+layers.{0,40}middleware/i,
      ],
      ['Gateway list/read promise', /subscribable resource URI/i],
      ['unsupported universal Components V2 claim', /every send\/edit tool accepts/i],
      ['unsupported universal confirmation claim', /every destructive (?:call|tool)/i],
      ['unsupported client allowlist key', /mcp\.toolAllowlist/],
      ['unverified schema-size claim', /~20kB/i],
      ['unverified throughput claim', /sustained 200\/min/i],
    ];

    const violations: string[] = [];
    for (const file of files) {
      const content = readFileSync(file, 'utf8');
      const path = relative(DOCS_DIR, file).replace(/\\/g, '/');
      for (const [label, pattern] of forbidden) {
        if (pattern.test(content)) violations.push(`${path}: ${label}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('keeps executable recipe credentials and scheduled events valid', () => {
    const webhook = readFileSync(join(DOCS_DIR, 'recipes/webhook-execute.mdx'), 'utf8');
    const webhookTokens = [...webhook.matchAll(/"token": "(REPLACE_WITH_WEBHOOK_TOKEN_[x]+)"/g)];
    expect(webhookTokens).toHaveLength(2);
    for (const match of webhookTokens) expect(match[1]!.length).toBeGreaterThanOrEqual(60);

    const pipeline = readFileSync(join(DOCS_DIR, 'recipes/pipeline-multistep.mdx'), 'utf8');
    const starts = [...pipeline.matchAll(/"scheduled_start_time": "([^"]+)"/g)];
    expect(starts.length).toBeGreaterThan(0);
    for (const match of starts) {
      expect(Date.parse(match[1]!)).toBeGreaterThan(Date.parse('2026-08-01T12:00:00.000Z'));
    }
  });

  it('keeps every internal docs link pointed at a real route', async () => {
    const files = collectMdxFiles(DOCS_DIR).filter(
      (file) => !relative(DOCS_DIR, file).replace(/\\/g, '/').startsWith('tools/'),
    );
    const routes = new Set(files.map(routeForMdx));
    const tools = await loadAllTools();
    routes.add('/discord-mcp/tools/');
    for (const tool of tools) {
      routes.add(`/discord-mcp/tools/${tool.category}/`);
      const slug = tool.name.startsWith(`${tool.category}_`)
        ? tool.name.slice(tool.category.length + 1)
        : tool.name;
      routes.add(`/discord-mcp/tools/${tool.category}/${slug}/`);
    }

    const broken: string[] = [];
    const linkPattern = /(?:href=["']|\]\()(?<url>\/discord-mcp\/[^"')\s#]*)/g;
    for (const file of files) {
      const sourceRoute = routeForMdx(file);
      const content = readFileSync(file, 'utf8');
      for (const match of content.matchAll(linkPattern)) {
        const url = match.groups?.url?.split('?')[0];
        if (url && !routes.has(url)) broken.push(`${sourceRoute} -> ${url}`);
      }
    }
    expect([...new Set(broken)].sort()).toEqual([]);
  });
});
