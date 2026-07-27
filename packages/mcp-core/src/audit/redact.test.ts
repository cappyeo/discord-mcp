import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { __SENSITIVE_KEYS_BY_TOOL_FOR_TESTS, redactArgs } from './redact.js';

describe('redactArgs (Plan 8 Phase F — per-tool + recursive)', () => {
  describe('global sensitive keys', () => {
    it('redacts globally sensitive top-level keys with length-aware marker', () => {
      const out = redactArgs(
        {
          channel_id: '111',
          token: 'super-secret',
          bearer_token: 'abc',
          auth: 'xyz',
          password: 'p@ss',
          secret: 's',
        },
        'webhooks_create',
      );
      expect(out.channel_id).toBe('111');
      expect(out.token).toBe('[REDACTED:12ch]');
      expect(out.bearer_token).toBe('[REDACTED:3ch]');
      expect(out.auth).toBe('[REDACTED:3ch]');
      expect(out.password).toBe('[REDACTED:4ch]');
      expect(out.secret).toBe('[REDACTED:1ch]');
    });

    it('redacts case-insensitively (TOKEN, Bearer_Token, etc.)', () => {
      const out = redactArgs({ TOKEN: 'x', Bearer_Token: 'yy' }, 'tool');
      expect(out.TOKEN).toBe('[REDACTED:1ch]');
      expect(out.Bearer_Token).toBe('[REDACTED:2ch]');
    });

    it('redacts interaction_token (live Discord interaction credential)', () => {
      const out = redactArgs({ interaction_token: 'x'.repeat(20) }, 'interactions_create_followup');
      expect(out.interaction_token).toBe('[REDACTED:20ch]');
    });

    it('redacts unknown credential-shaped keys (*_token, *_secret, *password*)', () => {
      const out = redactArgs(
        { future_token: 'a', client_secret: 'bb', user_password_hash: 'ccc' },
        'unknown_future_tool',
      );
      expect(out.future_token).toBe('[REDACTED:1ch]');
      expect(out.client_secret).toBe('[REDACTED:2ch]');
      expect(out.user_password_hash).toBe('[REDACTED:3ch]');
    });

    it('redacts globally sensitive keys nested deep inside objects', () => {
      const out = redactArgs({ wrapper: { inner: { token: 'leak-me-please' } } }, 'unknown_tool');
      const wrapper = out.wrapper as Record<string, unknown>;
      const inner = wrapper.inner as Record<string, unknown>;
      expect(inner.token).toBe('[REDACTED:14ch]');
    });
  });

  describe('length truncation', () => {
    it('truncates strings longer than 200 chars to 100 chars + suffix', () => {
      const long = 'a'.repeat(500);
      const out = redactArgs({ summary: long }, 'unknown_tool');
      const truncated = out.summary as string;
      expect(truncated).toHaveLength(100 + '...[TRUNCATED]'.length);
      expect(truncated.endsWith('...[TRUNCATED]')).toBe(true);
      expect(truncated.startsWith('a'.repeat(100))).toBe(true);
    });

    it('does NOT truncate strings up to 200 chars (boundary check)', () => {
      const at200 = 'b'.repeat(200);
      const at201 = 'c'.repeat(201);
      const out = redactArgs({ a: at200, b: at201 }, 'tool');
      expect(out.a).toBe(at200);
      expect((out.b as string).endsWith('...[TRUNCATED]')).toBe(true);
    });

    it('truncates leaf strings inside nested objects', () => {
      const long = 'd'.repeat(500);
      const out = redactArgs({ embed: { description: long } }, 'unknown_tool');
      const embed = out.embed as Record<string, unknown>;
      expect((embed.description as string).endsWith('...[TRUNCATED]')).toBe(true);
    });
  });

  describe('per-tool redaction (SENSITIVE_KEYS_BY_TOOL)', () => {
    it('messages_send redacts content', () => {
      const out = redactArgs({ channel_id: '111', content: 'secret data' }, 'messages_send');
      expect(out.channel_id).toBe('111');
      expect(out.content).toBe('[REDACTED:11ch]');
    });

    it('messages_edit redacts content', () => {
      const out = redactArgs({ message_id: '222', content: 'edit me' }, 'messages_edit');
      expect(out.content).toBe('[REDACTED:7ch]');
    });

    it('messages_bulk_delete redacts message_ids array (length only, no IDs leaked)', () => {
      const out = redactArgs(
        { channel_id: '111', message_ids: ['1', '2', '3'] },
        'messages_bulk_delete',
      );
      expect(out.channel_id).toBe('111');
      expect(out.message_ids).toBe('[REDACTED:value]');
    });

    it('webhooks_execute redacts content / embeds / components / attachments', () => {
      const out = redactArgs(
        {
          webhook_id: '111',
          content: 'hello',
          embeds: [{ title: 't' }],
          components: [{ type: 1 }],
          attachments: [{ id: 'a' }],
        },
        'webhooks_execute',
      );
      expect(out.webhook_id).toBe('111');
      expect(out.content).toBe('[REDACTED:5ch]');
      expect(out.embeds).toBe('[REDACTED:value]');
      expect(out.components).toBe('[REDACTED:value]');
      expect(out.attachments).toBe('[REDACTED:value]');
    });

    it('webhooks_edit_message redacts content / embeds / components', () => {
      const out = redactArgs(
        { message_id: '222', content: 'edit', embeds: [], components: [] },
        'webhooks_edit_message',
      );
      expect(out.content).toBe('[REDACTED:4ch]');
      expect(out.embeds).toBe('[REDACTED:value]');
      expect(out.components).toBe('[REDACTED:value]');
    });

    it('components_v2_send redacts content / components', () => {
      const out = redactArgs(
        { channel_id: '111', content: 'hi', components: [{ type: 1 }] },
        'components_v2_send',
      );
      expect(out.content).toBe('[REDACTED:2ch]');
      expect(out.components).toBe('[REDACTED:value]');
    });

    it('components_v2_edit redacts components', () => {
      const out = redactArgs(
        { message_id: '222', components: [{ type: 1 }] },
        'components_v2_edit',
      );
      expect(out.components).toBe('[REDACTED:value]');
    });

    // The tool's input field is `vars` (see tools/components-v2/send-from-template.ts);
    // an entry naming `variables` matched nothing and logged the rendered
    // message text verbatim.
    it('components_v2_send_from_template redacts vars (the real arg name)', () => {
      const out = redactArgs(
        { channel_id: '111', template: 'announcement', vars: { body: 'sensitive-body' } },
        'components_v2_send_from_template',
      );
      expect(out.channel_id).toBe('111');
      expect(out.vars).toBe('[REDACTED:value]');
      expect(JSON.stringify(out)).not.toContain('sensitive-body');
    });

    it('intelligence_summarize_channel redacts messages / channel_messages', () => {
      const out = redactArgs(
        { channel_id: '111', messages: ['m1'], channel_messages: ['m2'] },
        'intelligence_summarize_channel',
      );
      expect(out.messages).toBe('[REDACTED:value]');
      expect(out.channel_messages).toBe('[REDACTED:value]');
    });

    it('intelligence_classify_messages redacts messages', () => {
      const out = redactArgs({ messages: ['x', 'y'] }, 'intelligence_classify_messages');
      expect(out.messages).toBe('[REDACTED:value]');
    });

    it('intelligence_draft_response redacts conversation / context', () => {
      const out = redactArgs(
        { conversation: ['msg1'], context: { topic: 't' } },
        'intelligence_draft_response',
      );
      expect(out.conversation).toBe('[REDACTED:value]');
      expect(out.context).toBe('[REDACTED:value]');
    });

    it('intelligence_moderate_content redacts content / text', () => {
      const out = redactArgs(
        { content: 'naughty', text: 'naughty too' },
        'intelligence_moderate_content',
      );
      expect(out.content).toBe('[REDACTED:7ch]');
      expect(out.text).toBe('[REDACTED:11ch]');
    });

    it('intelligence_extract_entities redacts text / content', () => {
      const out = redactArgs(
        { text: 'PII here', content: 'more PII' },
        'intelligence_extract_entities',
      );
      expect(out.text).toBe('[REDACTED:8ch]');
      expect(out.content).toBe('[REDACTED:8ch]');
    });

    it('interactions_create_response redacts data', () => {
      const out = redactArgs(
        { interaction_id: 'i1', data: { content: 'reply' } },
        'interactions_create_response',
      );
      expect(out.data).toBe('[REDACTED:value]');
    });

    it('interactions_edit_original_response redacts content / embeds / components', () => {
      const out = redactArgs(
        {
          token: 'tok',
          content: 'updated',
          embeds: [{}],
          components: [{}],
        },
        'interactions_edit_original_response',
      );
      // 'token' covered by global redaction.
      expect(out.token).toBe('[REDACTED:3ch]');
      expect(out.content).toBe('[REDACTED:7ch]');
      expect(out.embeds).toBe('[REDACTED:value]');
      expect(out.components).toBe('[REDACTED:value]');
    });

    it('interactions_create_followup redacts content / embeds / components', () => {
      const out = redactArgs(
        { application_id: 'a1', content: 'hello', embeds: [{}], components: [{}] },
        'interactions_create_followup',
      );
      expect(out.application_id).toBe('a1');
      expect(out.content).toBe('[REDACTED:5ch]');
      expect(out.embeds).toBe('[REDACTED:value]');
      expect(out.components).toBe('[REDACTED:value]');
    });

    it('interactions_edit_followup redacts content / embeds / components', () => {
      const out = redactArgs(
        { message_id: '222', content: 'hello', embeds: [{}], components: [{}] },
        'interactions_edit_followup',
      );
      expect(out.message_id).toBe('222');
      expect(out.content).toBe('[REDACTED:5ch]');
      expect(out.embeds).toBe('[REDACTED:value]');
      expect(out.components).toBe('[REDACTED:value]');
    });

    it('every entry in SENSITIVE_KEYS_BY_TOOL has at least one assertion above', () => {
      // Sanity: catch a future contributor adding a tool to the map and
      // forgetting to add a corresponding test. Compare to the explicit
      // list this file actually exercises.
      const exercised = new Set([
        'messages_send',
        'messages_edit',
        'messages_bulk_delete',
        'webhooks_execute',
        'webhooks_edit_message',
        'components_v2_send',
        'components_v2_edit',
        'components_v2_send_from_template',
        'intelligence_summarize_channel',
        'intelligence_classify_messages',
        'intelligence_draft_response',
        'intelligence_moderate_content',
        'intelligence_extract_entities',
        'interactions_create_response',
        'interactions_edit_original_response',
        'interactions_create_followup',
        'interactions_edit_followup',
      ]);
      const declared = new Set(Object.keys(__SENSITIVE_KEYS_BY_TOOL_FOR_TESTS));
      // Sets must be equal — no orphans either way.
      expect([...declared].sort()).toEqual([...exercised].sort());
    });
  });

  // `payload_json` is an opaque JSON string carrying the same body as the
  // redacted `content`/`embeds`/… fields. Without an entry the same user
  // content was redacted under one key and logged in the clear under another.
  describe('payload_json (R2-RED-03)', () => {
    const PAYLOAD = JSON.stringify({ content: 'top-secret-body' });

    for (const tool of [
      'webhooks_execute',
      'webhooks_edit_message',
      'interactions_edit_original_response',
      'interactions_create_followup',
      'interactions_edit_followup',
    ]) {
      it(`${tool} redacts payload_json wholesale`, () => {
        const out = redactArgs({ channel_id: '111', payload_json: PAYLOAD }, tool);
        expect(out.channel_id).toBe('111');
        expect(out.payload_json).toBe(`[REDACTED:${PAYLOAD.length}ch]`);
        expect(JSON.stringify(out)).not.toContain('top-secret-body');
      });
    }
  });

  // `mcp_pipeline` args are `{steps:[{tool, args}]}` — the nested args belong
  // to the inner tools and must get the inner tools' redaction.
  describe('mcp_pipeline nested step args (R2-RED-05)', () => {
    it('applies the inner tool rules to steps[].args', () => {
      const out = redactArgs(
        {
          steps: [
            { id: 'list', tool: 'channels_list', args: { guild_id: '123' } },
            {
              id: 'send',
              tool: 'messages_send',
              args: { channel_id: '456', content: 'top-secret-body' },
            },
          ],
        },
        'mcp_pipeline',
      );
      const steps = out.steps as Array<Record<string, unknown>>;
      // Non-sensitive step args survive: the pipeline stays auditable.
      expect(steps[0].tool).toBe('channels_list');
      expect((steps[0].args as Record<string, unknown>).guild_id).toBe('123');
      // Inner-tool sensitive args are redacted exactly as a direct call.
      expect(steps[1].id).toBe('send');
      expect((steps[1].args as Record<string, unknown>).channel_id).toBe('456');
      expect((steps[1].args as Record<string, unknown>).content).toBe('[REDACTED:15ch]');
      expect(JSON.stringify(out)).not.toContain('top-secret-body');
    });

    it('drops step args wholesale when the step tool name is not a string', () => {
      const out = redactArgs(
        { steps: [{ tool: 42, args: { content: 'top-secret-body' } }] },
        'mcp_pipeline',
      );
      const steps = out.steps as Array<Record<string, unknown>>;
      expect(steps[0].args).toBe('[REDACTED:value]');
      expect(JSON.stringify(out)).not.toContain('top-secret-body');
    });

    it('keeps redacting later steps when an earlier step is malformed', () => {
      const out = redactArgs(
        {
          steps: [
            'oops',
            null,
            { tool: 'messages_send' },
            { tool: 'messages_send', args: { content: 'top-secret-body' } },
          ],
          token: 'creds',
        },
        'mcp_pipeline',
      );
      const steps = out.steps as unknown[];
      expect(out.token).toBe('[REDACTED:5ch]');
      expect(steps.slice(0, 3)).toEqual(['oops', null, { tool: 'messages_send' }]);
      expect((steps[3] as { args: Record<string, unknown> }).args.content).toBe('[REDACTED:15ch]');
    });

    it('redacts a nested mcp_pipeline step recursively', () => {
      const out = redactArgs(
        {
          steps: [
            {
              tool: 'mcp_pipeline',
              args: {
                steps: [{ tool: 'messages_send', args: { content: 'top-secret-body' } }],
              },
            },
          ],
        },
        'mcp_pipeline',
      );
      expect(JSON.stringify(out)).not.toContain('top-secret-body');
    });
  });

  describe('allowlist semantics', () => {
    it('tools NOT in SENSITIVE_KEYS_BY_TOOL only get global rules', () => {
      // `payload` is sensitive for messages_send (no — it's `content`),
      // but for an unknown tool it should pass through (truncated only).
      const out = redactArgs(
        { content: 'this is fine for unknown tool', payload: 'arbitrary' },
        'unknown_future_tool',
      );
      expect(out.content).toBe('this is fine for unknown tool');
      expect(out.payload).toBe('arbitrary');
    });

    it('global keys still redact for tools missing from the map', () => {
      const out = redactArgs({ token: 'oops' }, 'unknown_future_tool');
      expect(out.token).toBe('[REDACTED:4ch]');
    });
  });

  describe('non-string scalars and edge inputs', () => {
    it('passes non-string scalars through unchanged when key is not sensitive', () => {
      const out = redactArgs(
        { count: 5, flag: true, missing: null, undef: undefined },
        'unknown_tool',
      );
      expect(out.count).toBe(5);
      expect(out.flag).toBe(true);
      expect(out.missing).toBeNull();
      expect(out.undef).toBeUndefined();
    });

    it('returns an empty object when args is null / undefined / non-object / array', () => {
      expect(redactArgs(null, 'tool')).toEqual({});
      expect(redactArgs(undefined, 'tool')).toEqual({});
      expect(redactArgs('hello', 'tool')).toEqual({});
      expect(redactArgs(42, 'tool')).toEqual({});
      expect(redactArgs([1, 2, 3], 'tool')).toEqual({});
    });
  });
});

/**
 * Registry-wide guard: no credential-shaped arg on any tool may survive
 * `redactArgs` verbatim. Per-tool unit tests structurally cannot catch a new
 * tool that ships a `*_token` arg nobody added to the redaction sets.
 */
describe('redactArgs vs. the live tool registry', () => {
  const TOOLS_DIR = fileURLToPath(new URL('../tools/', import.meta.url));
  const CREDENTIAL_KEY_RE = /token|secret|password/i;

  const credentialArgs: Array<{ tool: string; key: string }> = [];

  beforeAll(async () => {
    const categories = readdirSync(TOOLS_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('_'))
      .map((e) => e.name);

    for (const category of categories) {
      const dir = join(TOOLS_DIR, category);
      const files = readdirSync(dir).filter(
        (f) =>
          f.endsWith('.ts') &&
          !f.endsWith('.test.ts') &&
          !f.endsWith('.bench.ts') &&
          !f.startsWith('_'),
      );
      for (const file of files) {
        const mod = await import(`file://${join(dir, file).replace(/\\/g, '/')}`);
        const meta = (
          mod.default as
            | { __toolMetadata?: { name: string; inputSchema: Record<string, unknown> } }
            | undefined
        )?.__toolMetadata;
        if (meta === undefined) continue;
        for (const key of Object.keys(meta.inputSchema)) {
          if (CREDENTIAL_KEY_RE.test(key)) credentialArgs.push({ tool: meta.name, key });
        }
      }
    }
  });

  it('redacts every credential-shaped arg name in the registry', () => {
    expect(credentialArgs.length).toBeGreaterThan(0);
    const leaked = credentialArgs.filter(({ tool, key }) => {
      const out = redactArgs({ [key]: 'x'.repeat(20) }, tool);
      return out[key] !== '[REDACTED:20ch]';
    });
    expect(leaked).toEqual([]);
  });
});
