import { type Meter, metrics } from '@opentelemetry/api';
import {
  ATTR_CACHE_OUTCOME,
  ATTR_DISCOVERY_CONTRACT_MODE,
  ATTR_DISCOVERY_DETAIL,
  ATTR_DISCOVERY_MATCH_BUCKET,
  ATTR_MCP_TOOL_STATUS,
  METRIC_CHANNEL_GUILD_CACHE_DURATION,
  METRIC_CHANNEL_GUILD_CACHE_LOOKUPS,
  METRIC_DISCOVERY_RESPONSE_BYTES,
  METRIC_DISCOVERY_SEARCHES,
  TELEMETRY_INSTRUMENTATION_NAME,
  TELEMETRY_INSTRUMENTATION_VERSION,
} from './conventions.js';

interface ProgressiveDiscoveryResponse {
  readonly detail: 'compact' | 'full';
  readonly total_matches: number;
  readonly matches: readonly Readonly<Record<string, unknown>>[];
}

type CacheOutcome = 'hit' | 'miss';
type CacheStatus = 'ok' | 'error';

interface PerformanceInstruments {
  readonly discoverySearches: ReturnType<Meter['createCounter']>;
  readonly discoveryResponseBytes: ReturnType<Meter['createHistogram']>;
  readonly cacheLookups: ReturnType<Meter['createCounter']>;
  readonly cacheDuration: ReturnType<Meter['createHistogram']>;
}

const instrumentsByMeter = new WeakMap<Meter, PerformanceInstruments>();

function getInstruments(meter: Meter): PerformanceInstruments {
  const existing = instrumentsByMeter.get(meter);
  if (existing !== undefined) return existing;
  const instruments = {
    discoverySearches: meter.createCounter(METRIC_DISCOVERY_SEARCHES),
    discoveryResponseBytes: meter.createHistogram(METRIC_DISCOVERY_RESPONSE_BYTES, { unit: 'By' }),
    cacheLookups: meter.createCounter(METRIC_CHANNEL_GUILD_CACHE_LOOKUPS),
    cacheDuration: meter.createHistogram(METRIC_CHANNEL_GUILD_CACHE_DURATION, { unit: 'ms' }),
  };
  instrumentsByMeter.set(meter, instruments);
  return instruments;
}

function matchBucket(total: number): '0' | '1' | '2-4' | '5-8' | '9+' {
  if (total === 0) return '0';
  if (total === 1) return '1';
  if (total <= 4) return '2-4';
  if (total <= 8) return '5-8';
  return '9+';
}

function contractMode(
  matches: ProgressiveDiscoveryResponse['matches'],
): 'none' | 'selected' | 'all' {
  const contracts = matches.filter((match) => Object.hasOwn(match, 'inputSchema')).length;
  if (contracts === 0) return 'none';
  return contracts === matches.length ? 'all' : 'selected';
}

/**
 * Record only bounded discovery-shape evidence. The payload is serialized to
 * measure transport size, but is never attached to telemetry.
 */
export function recordProgressiveDiscoveryEvidence(response: ProgressiveDiscoveryResponse): void {
  try {
    const attributes = {
      [ATTR_DISCOVERY_DETAIL]: response.detail,
      [ATTR_DISCOVERY_CONTRACT_MODE]: contractMode(response.matches),
      [ATTR_DISCOVERY_MATCH_BUCKET]: matchBucket(response.total_matches),
    };
    const instruments = getInstruments(
      metrics.getMeter(TELEMETRY_INSTRUMENTATION_NAME, TELEMETRY_INSTRUMENTATION_VERSION),
    );
    instruments.discoverySearches.add(1, attributes);
    instruments.discoveryResponseBytes.record(
      Buffer.byteLength(JSON.stringify(response)),
      attributes,
    );
  } catch {
    // Telemetry is strictly observational and must never affect an MCP response.
  }
}

/** Record cache effectiveness without exporting the channel or guild being resolved. */
export function recordChannelGuildCacheLookup(
  outcome: CacheOutcome,
  status: CacheStatus,
  durationMs: number,
): void {
  try {
    const attributes = {
      [ATTR_CACHE_OUTCOME]: outcome,
      [ATTR_MCP_TOOL_STATUS]: status,
    };
    const instruments = getInstruments(
      metrics.getMeter(TELEMETRY_INSTRUMENTATION_NAME, TELEMETRY_INSTRUMENTATION_VERSION),
    );
    instruments.cacheLookups.add(1, attributes);
    instruments.cacheDuration.record(Math.max(0, durationMs), attributes);
  } catch {
    // Telemetry is strictly observational and must never affect authorization.
  }
}
