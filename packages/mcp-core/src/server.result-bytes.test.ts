import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { HttpResponse, http } from 'msw';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { buildServer } from './server.js';
import expectedReport from './server.result-bytes.report.json' with { type: 'json' };

const CHANNEL_ID = '112233445566778899';
const GUILD_ID = '999000999000999000';
const LONG_CONTENT = `fixture-${'x'.repeat(1_992)}`;
// This is a serialized UTF-8 payload budget, not a model-token or billing claim.
const CLASS_BUDGET_BYTES = 768_000;
const TOOL_BUDGET_BYTES = {
  messages: 500_000,
  audit_log: 256_000,
  members: 768_000,
} as const;

function messageFixture(index: number) {
  return {
    id: `99900099900099${String(index).padStart(4, '0')}`,
    channel_id: CHANNEL_ID,
    content: LONG_CONTENT,
    author: {
      id: `999000999001${String(index).padStart(6, '0')}`,
      username: `fixture-user-${index}`,
      global_name: `Fixture User ${index}`,
      bot: false,
    },
    timestamp: `2026-04-28T12:${String(index % 60).padStart(2, '0')}:00.000000+00:00`,
    edited_timestamp: null,
    attachments: [],
    embeds: [],
  };
}

function utf8Bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function auditEntryFixture(index: number) {
  return {
    id: `999000999010${String(index).padStart(6, '0')}`,
    target_id: `999000999020${String(index).padStart(6, '0')}`,
    user_id: `999000999030${String(index).padStart(6, '0')}`,
    action_type: 20 + (index % 5),
    reason: `fixture moderation reason ${index} ${'r'.repeat(900)}`,
  };
}

function memberFixture(index: number) {
  return {
    user: {
      id: `999000999040${String(index).padStart(6, '0')}`,
      username: `fixture-member-${index}-${'u'.repeat(40)}`,
      global_name: `Fixture Member ${index} ${'g'.repeat(40)}`,
      bot: index % 17 === 0,
    },
    nick: `fixture-nick-${index}-${'n'.repeat(40)}`,
    roles: Array.from(
      { length: 5 },
      (_, role) => `99900099905${String(role + 1).padStart(7, '0')}`,
    ),
    joined_at: '2026-04-28T12:00:00.000000+00:00',
    premium_since: null,
    pending: false,
  };
}

function repeatedMessageContentBytes(result: {
  content?: unknown;
  structuredContent?: unknown;
}): number {
  const text =
    (result.content as Array<{ type?: string; text?: string }> | undefined)
      ?.filter((block) => block.type === 'text')
      .map((block) => block.text ?? '')
      .join('\n') ?? '';
  const structured = result.structuredContent as Record<string, unknown> | undefined;
  const values = Object.entries(structured ?? {})
    .filter(
      ([key]) => key === 'content' || key === 'messages' || key === 'matches' || key === 'pins',
    )
    .flatMap(([, value]) => (Array.isArray(value) ? value : [value]))
    .map((value) =>
      value && typeof value === 'object' ? (value as Record<string, unknown>).content : undefined,
    )
    .filter((value): value is string => typeof value === 'string');

  return values.reduce((total, value) => {
    return total + (text.includes(value) ? Buffer.byteLength(value, 'utf8') : 0);
  }, 0);
}

function duplicatedFieldBytes(
  result: { content?: unknown; structuredContent?: unknown },
  fields: string[],
) {
  const stringLeaves = (value: unknown): string[] => {
    if (typeof value === 'string') return [value];
    if (Array.isArray(value)) return value.flatMap(stringLeaves);
    if (value !== null && typeof value === 'object') {
      return Object.values(value as Record<string, unknown>).flatMap(stringLeaves);
    }
    return [];
  };
  const text =
    (result.content as Array<{ type?: string; text?: string }> | undefined)
      ?.filter((block) => block.type === 'text')
      .map((block) => block.text ?? '')
      .join('\n') ?? '';
  const structured = result.structuredContent as Record<string, unknown> | undefined;
  return fields.reduce((total, field) => {
    const values = stringLeaves(structured?.[field]);
    return (
      total +
      values.reduce(
        (sum, value) => (text.includes(value) ? sum + Buffer.byteLength(value, 'utf8') : sum),
        0,
      )
    );
  }, 0);
}

function measure(result: {
  content?: unknown;
  structuredContent?: unknown;
  [key: string]: unknown;
}) {
  const contentBytes = utf8Bytes(result.content);
  const structuredContentBytes = utf8Bytes(result.structuredContent);
  return {
    contentBytes,
    structuredContentBytes,
    totalSerializedBytes: utf8Bytes(result),
    duplicatedMessageContentBytes: repeatedMessageContentBytes(result),
  };
}

function reportRecord(
  tool: string,
  budgetClass: keyof typeof TOOL_BUDGET_BYTES,
  inputShape: string,
  itemCount: number,
  metrics: ReturnType<typeof measure>,
  duplicatedFieldBytes: number,
) {
  return {
    tool,
    resultClass: 'paginated_collection',
    budgetClass,
    inputShape,
    itemCount,
    contentBytes: metrics.contentBytes,
    structuredContentBytes: metrics.structuredContentBytes,
    totalSerializedBytes: metrics.totalSerializedBytes,
    duplicatedFieldBytes,
    classBudgetBytes: CLASS_BUDGET_BYTES,
    budgetBytes: TOOL_BUDGET_BYTES[budgetClass],
  };
}

describe('MCP result byte regression evidence', () => {
  const config = loadConfig({
    DISCORD_TOKEN: 'Bot fake.test.token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    LOG_LEVEL: 'fatal',
  });
  const logger = createLogger(config);
  let client: Client;
  const seenCursors = { messageBefore: '', messageAfter: '', memberAfter: '' };

  beforeAll(async () => {
    server.use(
      http.get('https://discord.com/api/v10/channels/:channelId/messages', ({ request }) => {
        const url = new URL(request.url);
        seenCursors.messageBefore = url.searchParams.get('before') ?? '';
        seenCursors.messageAfter = url.searchParams.get('after') ?? '';
        const limit = Math.min(Number(url.searchParams.get('limit') ?? 50), 100);
        return HttpResponse.json(
          Array.from({ length: limit }, (_, index) => messageFixture(index + 1)),
        );
      }),
      http.get('https://discord.com/api/v10/guilds/:guildId/audit-logs', ({ request }) => {
        const limit = Math.min(Number(new URL(request.url).searchParams.get('limit') ?? 50), 100);
        return HttpResponse.json({
          audit_log_entries: Array.from({ length: limit }, (_, i) => auditEntryFixture(i + 1)),
        });
      }),
      http.get('https://discord.com/api/v10/guilds/:guildId/members', ({ request }) => {
        const url = new URL(request.url);
        seenCursors.memberAfter = url.searchParams.get('after') ?? '';
        const limit = Math.min(Number(url.searchParams.get('limit') ?? 1), 1000);
        return HttpResponse.json(Array.from({ length: limit }, (_, i) => memberFixture(i + 1)));
      }),
      http.get('https://discord.com/api/v10/channels/:channelId/pins', () =>
        HttpResponse.json(Array.from({ length: 50 }, (_, index) => messageFixture(index + 201))),
      ),
    );
    const rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token');
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const built = await buildServer({ rest, logger, config });
    client = new Client({ name: 'result-byte-test', version: '0.0.0' }, { capabilities: {} });
    await Promise.all([built.server.connect(serverTransport), client.connect(clientTransport)]);
  });

  afterAll(async () => {
    await client.close();
  });

  it('keeps bounded deterministic byte evidence across representative result shapes', async () => {
    const report: Array<Record<string, string | number>> = [];
    const shapes = [1, 50, 100];
    for (const limit of shapes) {
      const read = await client.callTool({
        name: 'messages_read',
        arguments: { channel_id: CHANNEL_ID, limit },
      });
      const search = await client.callTool({
        name: 'messages_search_recent',
        arguments: { channel_id: CHANNEL_ID, query: 'fixture', limit },
      });

      for (const [name, result] of [
        [`messages_read_${limit}`, read],
        [`messages_search_recent_${limit}`, search],
      ] as const) {
        const metrics = measure(result as never);
        expect(metrics.totalSerializedBytes, name).toBeLessThanOrEqual(TOOL_BUDGET_BYTES.messages);
        expect(metrics.contentBytes, name).toBeGreaterThan(0);
        expect(metrics.structuredContentBytes, name).toBeGreaterThan(0);
        expect(metrics.duplicatedMessageContentBytes, name).toBe(
          limit * Buffer.byteLength(LONG_CONTENT, 'utf8'),
        );
        report.push(
          reportRecord(
            name.replace(/_\d+$/, ''),
            'messages',
            limit === 1 ? 'small' : limit === 50 ? 'default' : 'maximum',
            limit,
            metrics,
            metrics.duplicatedMessageContentBytes,
          ),
        );
      }
    }

    const pins = await client.callTool({
      name: 'messages_list_pins',
      arguments: { channel_id: CHANNEL_ID },
    });
    const pinMetrics = measure(pins as never);
    expect(pinMetrics.totalSerializedBytes).toBeLessThanOrEqual(TOOL_BUDGET_BYTES.messages);
    expect(pinMetrics.duplicatedMessageContentBytes).toBe(
      50 * Buffer.byteLength(LONG_CONTENT, 'utf8'),
    );
    report.push(
      reportRecord(
        'messages_list_pins',
        'messages',
        'maximum',
        50,
        pinMetrics,
        pinMetrics.duplicatedMessageContentBytes,
      ),
    );
    await client.callTool({
      name: 'messages_read',
      arguments: {
        channel_id: CHANNEL_ID,
        limit: 1,
        before: '999000999000990001',
        after: '999000999000990002',
      },
    });
    expect(seenCursors.messageBefore).toBe('999000999000990001');
    expect(seenCursors.messageAfter).toBe('999000999000990002');
    for (const limit of [1, 50, 100]) {
      const result = await client.callTool({
        name: 'audit_log_get',
        arguments: { guild_id: GUILD_ID, limit },
      });
      const metrics = measure(result as never);
      expect(metrics.totalSerializedBytes).toBeLessThanOrEqual(TOOL_BUDGET_BYTES.audit_log);
      report.push(
        reportRecord(
          'audit_log_get',
          'audit_log',
          limit === 1 ? 'small' : limit === 50 ? 'default' : 'maximum',
          limit,
          metrics,
          duplicatedFieldBytes(result as never, ['entries']),
        ),
      );
    }
    for (const limit of [1, 100, 1000]) {
      const result = await client.callTool({
        name: 'members_list',
        arguments: {
          guild_id: GUILD_ID,
          limit,
          ...(limit === 1 ? { after: '999000999040000001' } : {}),
        },
      });
      const metrics = measure(result as never);
      expect(metrics.totalSerializedBytes).toBeLessThanOrEqual(TOOL_BUDGET_BYTES.members);
      report.push(
        reportRecord(
          'members_list',
          'members',
          limit === 1 ? 'small' : limit === 100 ? 'default' : 'maximum',
          limit,
          metrics,
          duplicatedFieldBytes(result as never, ['members']),
        ),
      );
      if (limit === 1) expect(seenCursors.memberAfter).toBe('999000999040000001');
    }
    const ranked = [...report].sort(
      (a, b) =>
        Number(b.totalSerializedBytes) - Number(a.totalSerializedBytes) ||
        (String(a.tool) < String(b.tool) ? -1 : String(a.tool) > String(b.tool) ? 1 : 0) ||
        Number(a.itemCount) - Number(b.itemCount),
    );
    expect({
      schemaVersion: 1,
      claimBoundary: 'serialized UTF-8 MCP payload bytes only; not token or billing claims',
      classBudgets: { paginated_collection: CLASS_BUDGET_BYTES },
      records: ranked,
    }).toEqual(expectedReport);
    expect(ranked.every((entry) => entry.totalSerializedBytes <= entry.classBudgetBytes)).toBe(
      true,
    );
    expect(ranked.every((entry) => entry.totalSerializedBytes <= entry.budgetBytes)).toBe(true);
  });
});
