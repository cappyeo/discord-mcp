import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';

const server = new McpServer({ name: 'benchmark-fixture', version: '1.0.0' });
const PLAN_ID = `sha256:${'b'.repeat(64)}`;
const BLUEPRINT_ID = `sha256:${'a'.repeat(64)}`;
const SNAPSHOT_ID = `sha256:${'c'.repeat(64)}`;
const APPROVAL_ID = `sha256:${'d'.repeat(64)}`;
const EVIDENCE_ID = `sha256:${'e'.repeat(64)}`;
const TEMPLATE_CODE = 'WNSCpfHWnqXr';
const CATALOG_VERSION = 'fixture-catalog-v1';

const TEMPLATE_EVIDENCE = {
  primary: {
    code: TEMPLATE_CODE,
    use_url: `https://discord.new/${TEMPLATE_CODE}`,
    quality: {
      verified: true,
      code_match: true,
      permission_handling: 'discarded_and_regenerated',
    },
    provenance: {
      evidence_digest: `sha256:${'f'.repeat(64)}`,
      fetched_at: '2026-08-12T00:00:00.000Z',
      source_guild: {
        id: '999000999000999002',
        snapshot_id: 'fixture-source-snapshot',
        icon_hash: null,
        preferred_locale: 'en-US',
      },
    },
  },
  inspirations: [],
};

const PLAN_CONTRACT = {
  name: 'guild_blueprint_plan',
  category: 'guild',
  dispatcher: 'mcp_tools_read',
  summary: 'Build a target-bound Discord server blueprint preview.',
  description: 'Build a target-bound Discord server blueprint preview from one request.',
  inputSchema: {
    type: 'object',
    properties: {
      request: { type: 'string' },
      guild_id: { type: 'string' },
      expected_bot_id: { type: 'string' },
      preferred_primary_code: { type: 'string' },
    },
    required: ['request'],
  },
  annotations: { readOnlyHint: true, destructiveHint: false },
};

const APPLY_CONTRACT = {
  name: 'guild_blueprint_apply',
  category: 'guild',
  dispatcher: 'mcp_tools_destructive',
  summary: 'Apply an approved Discord server blueprint.',
  description: 'Apply an approved target-bound blueprint with explicit confirmation.',
  inputSchema: {
    type: 'object',
    properties: {
      approval_id: { type: 'string' },
      expected_bot_id: { type: 'string' },
      guild_id: { type: 'string' },
      plan_token: { type: 'string' },
      __confirm: { type: 'boolean' },
      operation_budget: { type: 'integer', minimum: 1, maximum: 50, default: 25 },
    },
    required: ['approval_id', 'expected_bot_id', 'guild_id', 'plan_token'],
  },
  annotations: { readOnlyHint: false, destructiveHint: true },
};

const EVIDENCE_CONTRACT = {
  name: 'guild_blueprint_evidence',
  category: 'guild',
  dispatcher: 'mcp_tools_read',
  summary: 'Verify persisted blueprint Activity Evidence.',
  description: 'Verify the current guild against persisted blueprint Activity Evidence.',
  inputSchema: {
    type: 'object',
    properties: {
      expected_bot_id: { type: 'string' },
      guild_id: { type: 'string' },
      plan_id: { type: 'string' },
    },
    required: ['expected_bot_id', 'guild_id', 'plan_id'],
  },
  annotations: { readOnlyHint: true, destructiveHint: false },
};

const CONTRACTS = new Map([
  [PLAN_CONTRACT.name, PLAN_CONTRACT],
  [APPLY_CONTRACT.name, APPLY_CONTRACT],
  [EVIDENCE_CONTRACT.name, EVIDENCE_CONTRACT],
]);

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function errorResult(code, message) {
  return {
    isError: true,
    content: [{ type: 'text', text: `**${code}**: ${message}` }],
    structuredContent: {
      code,
      retriable: false,
      category: 'client',
      recovery_hint: 'Use the exact progressive contract returned by mcp_tools_search.',
    },
  };
}

function exactKeys(value, expected) {
  return (
    record(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort())
  );
}

function requiredAndOptionalKeys(value, required, optional) {
  return (
    record(value) &&
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => required.includes(key) || optional.includes(key))
  );
}

function validSearchArgs(args) {
  return (
    record(args) &&
    exactKeys(args, ['query', 'limit']) &&
    typeof args.query === 'string' &&
    args.query.trim() !== '' &&
    args.limit === 1
  );
}

function searchMatch(query) {
  const normalized = query.trim().toLowerCase();
  if (CONTRACTS.has(normalized)) return CONTRACTS.get(normalized);
  if (
    /\b(build|create|design|setup|dung|dựng)\b/i.test(normalized) &&
    /\b(server|community|guild)\b/i.test(normalized)
  ) {
    return PLAN_CONTRACT;
  }
  return null;
}

function search(args) {
  if (!validSearchArgs(args)) {
    return errorResult('VALIDATION_FAILED', 'Progressive search requires query and limit:1.');
  }
  const match = searchMatch(args.query);
  return {
    query: args.query,
    category: null,
    detail: 'compact',
    total_matches: match === null ? 0 : 1,
    matches: match === null ? [] : [match],
    categories: [{ name: 'guild', tool_count: CONTRACTS.size }],
  };
}

function nestedArgs(args, contract) {
  if (!record(args) || !exactKeys(args, ['tool', 'args']) || args.tool !== contract.name) {
    return errorResult('DISPATCH_MODE_MISMATCH', `Use the exact ${contract.dispatcher} contract.`);
  }
  const expected =
    contract.name === PLAN_CONTRACT.name
      ? ['request']
      : contract.name === EVIDENCE_CONTRACT.name
        ? ['expected_bot_id', 'guild_id', 'plan_id']
        : ['approval_id', 'expected_bot_id', 'guild_id', 'plan_token'];
  const optional =
    contract.name === PLAN_CONTRACT.name
      ? ['expected_bot_id', 'guild_id', 'preferred_primary_code']
      : contract.name === APPLY_CONTRACT.name
        ? ['__confirm', 'operation_budget']
        : [];
  if (!requiredAndOptionalKeys(args.args, expected, optional)) {
    return errorResult('VALIDATION_FAILED', `Nested args for ${contract.name} are invalid.`);
  }
  if (typeof args.args.request !== 'undefined' && typeof args.args.request !== 'string') {
    return errorResult('VALIDATION_FAILED', 'Plan request must be a string.');
  }
  for (const field of ['guild_id', 'expected_bot_id', 'preferred_primary_code']) {
    if (typeof args.args[field] !== 'undefined' && typeof args.args[field] !== 'string') {
      return errorResult('VALIDATION_FAILED', `${field} must be a string.`);
    }
  }
  if (
    contract.name === APPLY_CONTRACT.name &&
    (args.args.__confirm !== true ||
      (args.args.operation_budget !== undefined &&
        (!Number.isInteger(args.args.operation_budget) ||
          args.args.operation_budget < 1 ||
          args.args.operation_budget > 50)))
  ) {
    return errorResult('VALIDATION_FAILED', 'Apply confirmation or operation budget is invalid.');
  }
  for (const field of ['approval_id', 'plan_token', 'plan_id']) {
    if (typeof args.args[field] !== 'undefined' && typeof args.args[field] !== 'string') {
      return errorResult('VALIDATION_FAILED', `${field} must be a string.`);
    }
  }
  return null;
}

function dispatch(dispatcher, args) {
  if (!record(args) || !exactKeys(args, ['tool', 'args'])) {
    return errorResult('VALIDATION_FAILED', 'Dispatcher requires tool and nested args.');
  }
  const contract = CONTRACTS.get(args.tool);
  if (contract === undefined || contract.dispatcher !== dispatcher) {
    return errorResult('DISPATCH_MODE_MISMATCH', 'Use the dispatcher returned by discovery.');
  }
  const invalid = nestedArgs(args, contract);
  if (invalid !== null) return invalid;
  if (contract.name === PLAN_CONTRACT.name) {
    return {
      status: 'ready',
      tool: contract.name,
      request: args.args.request,
      target: {
        guild_id: args.args.guild_id ?? '999000999000999001',
        bot_id: args.args.expected_bot_id ?? '999000999000999000',
      },
      source: {
        catalog_version: CATALOG_VERSION,
        ...TEMPLATE_EVIDENCE,
        permission_policy: 'discard_source_and_regenerate',
      },
      blueprint_id: BLUEPRINT_ID,
      snapshot_id: SNAPSHOT_ID,
      plan_id: PLAN_ID,
      approval_id: APPROVAL_ID,
      plan_token: 'fixture-plan-token',
      blueprint: {
        roles: [],
        categories: [],
        channels: [{ key: 'general' }],
        onboarding: { prompts: [] },
        automod: { rules: [] },
        components_v2: { publications: [{ key: 'welcome', channel_key: 'general' }] },
      },
      operations: [{ operation_id: 'channel:create:general' }],
      blockers: [],
    };
  }
  if (contract.name === APPLY_CONTRACT.name) {
    return {
      status: 'complete',
      tool: contract.name,
      confirmed: true,
      plan_id: PLAN_ID,
      blueprint_id: BLUEPRINT_ID,
      target: { guild_id: args.args.guild_id, bot_id: args.args.expected_bot_id },
      progress: { remaining: 0 },
      evidence: { identity_verified: true, guild_verified: true, readback: 'match' },
    };
  }
  return {
    status: 'verified',
    tool: contract.name,
    plan_id: args.args.plan_id,
    blueprint_id: BLUEPRINT_ID,
    evidence_id: EVIDENCE_ID,
    target: { guild_id: args.args.guild_id, bot_id: args.args.expected_bot_id },
    record: {
      schema_version: 'guild_blueprint_activity_evidence.v1',
      recorded_at: '2026-08-12T00:00:00.000Z',
      initial_operation_count: 1,
      plan_invariants: {
        expected_counts: {
          identity: 2,
          roles: 0,
          categories: 0,
          channels: 1,
          ordering: 2,
          guild: 1,
          welcome_screen: 1,
          onboarding: 1,
          automod: 0,
          components_v2: 1,
        },
        safety_policy: {
          source_permissions_applied: false,
          dangerous_generated_permissions: 0,
          bot_permission_grants: 0,
          discord_managed_role_mutations: 0,
        },
      },
      observed: {
        initial_snapshot_id: SNAPSHOT_ID,
        final_snapshot_id: SNAPSHOT_ID,
        checkpoint_version: 1,
        completed_operation_ids: ['channel:create:general'],
        bindings: { roles: {}, categories: {}, channels: {}, automod_rules: {}, publications: {} },
        blueprint_readback_match: true,
      },
    },
    verification: {
      identity_verified: true,
      guild_verified: true,
      readback: 'match',
      snapshot_unchanged: true,
      current_snapshot: {
        snapshot_id: SNAPSHOT_ID,
        guild: { id: args.args.guild_id, name: 'fixture', features: [] },
        bot_id: args.args.expected_bot_id,
        resources: { roles: 0, categories: 0, channels: 1, automod_rules: 0, recent_messages: 0 },
        onboarding_enabled: false,
        welcome_screen_configured: false,
      },
      remaining_operations: [],
      blockers: [],
      warnings: [],
    },
  };
}

const names =
  process.env.MCP_TOOL_SURFACE === 'progressive'
    ? ['mcp_tools_search', 'mcp_tools_read', 'mcp_tools_write', 'mcp_tools_destructive']
    : ['guild_blueprint_plan', 'guild_blueprint_apply', 'guild_blueprint_evidence'];

for (const name of names) {
  const inputSchema =
    name === 'mcp_tools_search'
      ? z.object({ query: z.string(), limit: z.number().int() }).strict()
      : name.startsWith('mcp_tools_')
        ? z.object({ tool: z.string(), args: z.record(z.string(), z.unknown()) }).strict()
        : z.object({}).strict();
  server.registerTool(
    name,
    { description: `Benchmark MCP ${name} transport fixture.`, inputSchema },
    async (args) => {
      const result =
        name === 'mcp_tools_search'
          ? search(args)
          : name === 'mcp_tools_read'
            ? dispatch('mcp_tools_read', args)
            : name === 'mcp_tools_destructive'
              ? dispatch('mcp_tools_destructive', args)
              : name === 'mcp_tools_write'
                ? errorResult(
                    'TOOL_NOT_AVAILABLE',
                    'No write fixture contract is in this benchmark.',
                  )
                : { status: 'fixture', tool: name };
      return result.isError === true
        ? result
        : {
            content: [{ type: 'text', text: `${name} fixture response` }],
            structuredContent: result,
          };
    },
  );
}

await server.connect(new StdioServerTransport());
