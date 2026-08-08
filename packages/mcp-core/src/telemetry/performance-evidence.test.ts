import type { REST } from '@discordjs/rest';
import type { Tool as McpTool } from '@modelcontextprotocol/server';
import { metrics } from '@opentelemetry/api';
import {
  AggregationTemporality,
  DataPointType,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveChannelGuildId } from '../rest/channel-guild-cache.js';
import { createProgressiveToolCatalog, searchProgressiveTools } from '../tool-discovery.js';

describe('performance evidence telemetry', () => {
  let exporter: InMemoryMetricExporter;
  let meterProvider: MeterProvider;
  let reader: PeriodicExportingMetricReader;

  beforeEach(() => {
    exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    reader = new PeriodicExportingMetricReader({
      exporter,
      exportIntervalMillis: 60_000,
    });
    meterProvider = new MeterProvider({ readers: [reader] });
    metrics.setGlobalMeterProvider(meterProvider);
  });

  afterEach(async () => {
    metrics.disable();
    await meterProvider.shutdown();
  });

  it('records bounded discovery response evidence without query or payload labels', async () => {
    const visibleTools: McpTool[] = [
      { name: 'channels_get', description: 'Read one channel.', inputSchema: { type: 'object' } },
      { name: 'channels_list', description: 'List channels.', inputSchema: { type: 'object' } },
      { name: 'channels_edit', description: 'Edit one channel.', inputSchema: { type: 'object' } },
    ];
    const catalog = createProgressiveToolCatalog(
      visibleTools,
      new Map(visibleTools.map((tool) => [tool.name, 'channels'])),
    );
    searchProgressiveTools({ query: 'channels', limit: 3 }, catalog);
    await reader.forceFlush();

    const all = exporter
      .getMetrics()
      .flatMap((resource) => resource.scopeMetrics.flatMap((scope) => scope.metrics));
    const searches = all.find((metric) => metric.descriptor.name === 'mcp.discovery.searches');
    const bytes = all.find((metric) => metric.descriptor.name === 'mcp.discovery.response_bytes');

    expect(searches?.dataPoints[0]?.attributes).toEqual({
      'mcp.discovery.detail': 'compact',
      'mcp.discovery.contract_mode': 'none',
      'mcp.discovery.match_bucket': '2-4',
    });
    expect(searches?.dataPoints[0]?.value).toBe(1);
    expect(bytes?.dataPointType).toBe(DataPointType.HISTOGRAM);
    expect(bytes?.dataPoints[0]?.value.count).toBe(1);
    expect(bytes?.dataPoints[0]?.value.sum).toBeGreaterThan(0);
  });

  it('records cache hits and misses separately without a channel or guild label', async () => {
    const get = vi.fn().mockResolvedValue({ guild_id: '987654321098765432' });
    const rest = { get } as unknown as REST;
    await resolveChannelGuildId(rest, '123456789012345678');
    await resolveChannelGuildId(rest, '123456789012345678');
    await reader.forceFlush();

    const all = exporter
      .getMetrics()
      .flatMap((resource) => resource.scopeMetrics.flatMap((scope) => scope.metrics));
    const lookups = all.find(
      (metric) => metric.descriptor.name === 'mcp.channel_guild_cache.lookups',
    );
    const durations = all.find(
      (metric) => metric.descriptor.name === 'mcp.channel_guild_cache.duration_ms',
    );
    const lookupOutcomes = new Map(
      lookups?.dataPoints.map((point) => [point.attributes['mcp.cache.outcome'], point.value]) ??
        [],
    );

    expect(lookupOutcomes).toEqual(
      new Map([
        ['miss', 1],
        ['hit', 1],
      ]),
    );
    expect(get).toHaveBeenCalledOnce();
    expect(durations?.dataPointType).toBe(DataPointType.HISTOGRAM);
    for (const point of durations?.dataPoints ?? []) {
      expect(point.attributes).toEqual(
        expect.objectContaining({
          'mcp.cache.outcome': expect.any(String),
          status: 'ok',
        }),
      );
      expect(point.attributes.channel_id).toBeUndefined();
      expect(point.attributes.guild_id).toBeUndefined();
    }
  });
});
