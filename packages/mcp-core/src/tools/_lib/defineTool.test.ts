import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineTool, OutputSchemaViolation, type ToolMetadataStatic } from './defineTool.js';

describe('defineTool', () => {
  it('rejects invalid structured output with the tool name and field path', async () => {
    const InvalidTool = defineTool({
      name: 'invalid_output',
      description: 'Exercise the output contract guard',
      inputSchema: {},
      outputSchema: { count: z.number() },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      handler: async () => ({ structuredContent: { count: 'wrong type' } }),
    });
    const tool = new InvalidTool(
      { name: 'invalid_output', path: 'memory', root: 'memory', store: null as never },
      { name: 'invalid_output', enabled: true },
    );
    const result = tool.run({}, { signal: new AbortController().signal });
    await expect(result).rejects.toBeInstanceOf(OutputSchemaViolation);
    await expect(result).rejects.toThrow(/invalid_output.*count:/);
  });

  it('produces a Tool subclass with correct name + schema', async () => {
    const EchoCls = defineTool({
      name: 'test_echo',
      description: 'Echo back input',
      inputSchema: { msg: z.string().describe('Message to echo') },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      handler: async ({ msg }) => ({ echoed: msg }),
    });

    const instance = new EchoCls(
      { name: 'test_echo', path: 'memory', root: 'memory', store: null as never },
      { name: 'test_echo', enabled: true },
    );

    expect(instance.name).toBe('test_echo');
    expect(instance.description).toBe('Echo back input');
    expect(instance.inputSchema.msg).toBeDefined();
    expect(instance.annotations.readOnlyHint).toBe(true);

    const result = await instance.run({ msg: 'hello' }, { signal: new AbortController().signal });
    expect(result).toEqual({ echoed: 'hello' });
  });

  it('rejects names that violate snake_case verb-first rule', () => {
    expect(() =>
      defineTool({
        name: 'BadName',
        description: '',
        inputSchema: {},
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
        handler: async () => ({}),
      }),
    ).toThrow(/snake_case/);
  });

  it('attaches __toolMetadata for build-time introspection', () => {
    const Tool = defineTool({
      name: 'meta_introspect',
      description: 'Introspect me',
      category: 'meta',
      preconditions: ['category_enabled'] as const,
      inputSchema: { foo: z.string().describe('Foo field') },
      outputSchema: { bar: z.number() },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      idempotent: true,
      handler: async () => ({ bar: 1 }),
    });

    const meta = (Tool as unknown as { __toolMetadata?: ToolMetadataStatic }).__toolMetadata;
    expect(meta).toBeDefined();
    expect(meta?.name).toBe('meta_introspect');
    expect(meta?.category).toBe('meta');
    expect(meta?.description).toBe('Introspect me');
    expect(meta?.idempotent).toBe(true);
    expect(meta?.preconditions).toEqual(['category_enabled']);
    expect(meta?.inputSchema.foo).toBeDefined();
    expect(meta?.outputSchema?.bar).toBeDefined();
    expect(meta?.annotations.readOnlyHint).toBe(true);
    expect(meta?.annotations.destructiveHint).toBe(false);
  });

  it('__toolMetadata defaults idempotent=false and preconditions=[]', () => {
    const Tool = defineTool({
      name: 'meta_defaults',
      description: 'd',
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      handler: async () => ({}),
    });
    const meta = (Tool as unknown as { __toolMetadata?: ToolMetadataStatic }).__toolMetadata;
    expect(meta?.category).toBe('misc');
    expect(meta?.idempotent).toBe(false);
    expect(meta?.preconditions).toEqual([]);
  });

  it('compacts the authored description for the MCP wire', () => {
    const Probe = defineTool({
      name: 'compact_probe',
      description: [
        '**Purpose**: Probe the compaction.',
        '',
        '**When to use**:',
        '- Always.',
        '',
        '**Returns**: `{ok}`.',
        '',
        '**Security**: gated by `ConfirmRequired`.',
      ].join('\n'),
      inputSchema: {},
      outputSchema: { ok: z.boolean() },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      handler: async () => ({ ok: true }),
    });
    const instance = new Probe(
      { name: 'compact_probe', path: 'memory', root: 'memory', store: null as never },
      { name: 'compact_probe', enabled: true },
    );
    expect(instance.description).toBe(
      'Purpose: Probe the compaction.\n\nWhen to use: - Always.\n\nReturns: `{ok}`.\n\nSecurity: gated by `ConfirmRequired`.',
    );
    // defineTool hands back `typeof Tool`; the build-time static is attached inside it.
    const WithMeta = Probe as unknown as { __toolMetadata?: ToolMetadataStatic };
    expect(WithMeta.__toolMetadata?.description).toContain('**Returns**: `{ok}`.');
  });

  it('keeps the Returns section when the tool publishes no outputSchema', () => {
    const Probe = defineTool({
      name: 'compact_no_output',
      description: ['**Purpose**: Probe the compaction.', '', '**Returns**: `{ok}`.'].join('\n'),
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      handler: async () => ({ ok: true }),
    });
    const instance = new Probe(
      { name: 'compact_no_output', path: 'memory', root: 'memory', store: null as never },
      { name: 'compact_no_output', enabled: true },
    );
    expect(instance.description).toContain('Returns: `{ok}`.');
  });

  it('handles long malformed Markdown while preserving leading text and safety semantics', () => {
    const description = `Keep inline \`**word**:\` literal.\n\n**)**:${'\t'.repeat(50_000)}\n\n**Security**: Require approval.\n\n**Returns**: Empty means unknown.`;
    const Probe = defineTool({
      name: 'large_description',
      description,
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      handler: async () => ({}),
    });
    const tool = new Probe(
      { name: 'large_description', path: 'inline', root: 'inline', store: null as never },
      { name: 'large_description' },
    );
    expect(tool.description).toBe(
      'Keep inline `**word**:` literal.\n\n):\n\nSecurity: Require approval.\n\nReturns: Empty means unknown.',
    );
  });

  it('preserves fenced examples and descriptions containing only Returns', () => {
    for (const description of [
      '**Returns**: Empty means unknown, not absent.',
      '**Example**:\n```json\n{\n  "value": 1\n}\n```',
    ]) {
      const Probe = defineTool({
        name: 'format_probe',
        description,
        inputSchema: {},
        outputSchema: { value: z.number() },
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
        handler: async () => ({ value: 1 }),
      });
      const tool = new Probe(
        { name: 'format_probe', path: 'inline', root: 'inline', store: null as never },
        { name: 'format_probe' },
      );
      expect(tool.description).toBe(
        description.startsWith('**Example**')
          ? description
          : 'Returns: Empty means unknown, not absent.',
      );
    }
  });

  it('passes category, preconditions, and scopes from config to subclass', async () => {
    const Tool = defineTool({
      name: 'with_meta',
      description: 'meta',
      category: 'messages',
      preconditions: ['category_enabled'] as const,
      scopes: ['write'] as const,
      inputSchema: {},
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      handler: async () => ({}),
    });
    const t = new Tool(
      { name: 'with_meta', path: 'memory', root: 'memory', store: null as never },
      { name: 'with_meta', enabled: true },
    );
    expect(t.category).toBe('messages');
    expect(t.preconditions).toEqual(['category_enabled']);
    expect(t.scopes).toEqual(['write']);
  });
});
