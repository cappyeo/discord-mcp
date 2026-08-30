import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { HttpResponse, http } from 'msw';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { buildServer } from './server.js';

const CHANNEL_ID = '112233445566778899';
const LONG_CONTENT = `fixture-${'x'.repeat(1_992)}`;
// This is a serialized UTF-8 payload budget, not a model-token or billing claim.
const MAX_RESULT_BYTES = 500_000;

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

describe('MCP result byte regression evidence', () => {
  const config = loadConfig({
    DISCORD_TOKEN: 'Bot fake.test.token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    LOG_LEVEL: 'fatal',
  });
  const logger = createLogger(config);
  let client: Client;

  beforeAll(async () => {
    server.use(
      http.get('https://discord.com/api/v10/channels/:channelId/messages', ({ request }) => {
        const limit = Math.min(Number(new URL(request.url).searchParams.get('limit') ?? 50), 100);
        return HttpResponse.json(
          Array.from({ length: limit }, (_, index) => messageFixture(index + 1)),
        );
      }),
      http.get('https://discord.com/api/v10/channels/:channelId/pins', () =>
        HttpResponse.json([
          {
            id: '999000999000999001',
            channel_id: CHANNEL_ID,
            content: LONG_CONTENT,
            author: { id: '999000999000999010', username: 'pinbot', global_name: 'Pin Bot' },
            timestamp: '2026-04-28T12:00:00.000000+00:00',
          },
          {
            id: '999000999000999002',
            channel_id: CHANNEL_ID,
            content: LONG_CONTENT,
            author: { id: '999000999000999011', username: 'helper', global_name: 'Helper' },
            timestamp: '2026-04-28T12:01:00.000000+00:00',
          },
        ]),
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
        expect(metrics.totalSerializedBytes, name).toBeLessThanOrEqual(MAX_RESULT_BYTES);
        expect(metrics.contentBytes, name).toBeGreaterThan(0);
        expect(metrics.structuredContentBytes, name).toBeGreaterThan(0);
        expect(metrics.duplicatedMessageContentBytes, name).toBe(
          limit * Buffer.byteLength(LONG_CONTENT, 'utf8'),
        );
      }
    }

    const pins = await client.callTool({
      name: 'messages_list_pins',
      arguments: { channel_id: CHANNEL_ID },
    });
    const pinMetrics = measure(pins as never);
    expect(pinMetrics.totalSerializedBytes).toBeLessThanOrEqual(MAX_RESULT_BYTES);
    expect(pinMetrics.duplicatedMessageContentBytes).toBe(
      2 * Buffer.byteLength(LONG_CONTENT, 'utf8'),
    );
  });
});
