import { describe, expect, it } from 'vitest';
import * as conventions from './conventions.js';

describe('telemetry conventions', () => {
  it('exports non-empty string attribute keys', () => {
    const exported = Object.values(conventions);
    expect(exported.length).toBeGreaterThan(0);
    for (const v of exported) {
      expect(typeof v).toBe('string');
      expect((v as string).length).toBeGreaterThan(0);
    }
  });

  it('exports the expected MCP tool attribute keys', () => {
    expect(conventions.ATTR_MCP_TOOL_NAME).toBe('mcp.tool.name');
    expect(conventions.ATTR_MCP_TOOL_CATEGORY).toBe('mcp.tool.category');
    expect(conventions.ATTR_MCP_TOOL_IDEMPOTENT).toBe('mcp.tool.idempotent');
    expect(conventions.ATTR_MCP_REQUEST_ID).toBe('mcp.request_id');
    expect(conventions.ATTR_MCP_TRANSPORT).toBe('mcp.transport');
  });

  it('exports the expected metric names', () => {
    expect(conventions.METRIC_TOOL_DURATION).toBe('mcp.tool.duration_ms');
    expect(conventions.METRIC_TOOL_CALLS).toBe('mcp.tool.calls');
    expect(conventions.METRIC_TOOL_ERRORS).toBe('mcp.tool.errors');
  });

  it('exports the instrumentation name + version', () => {
    expect(conventions.TELEMETRY_INSTRUMENTATION_NAME).toBe('@discord-mcp/core');
    expect(conventions.TELEMETRY_INSTRUMENTATION_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('exports Phase D resilience metric names', () => {
    expect(conventions.METRIC_CIRCUIT_TRANSITIONS).toBe('mcp.circuit.transitions');
    expect(conventions.METRIC_BULKHEAD_REJECTED).toBe('mcp.bulkhead.rejected.count');
    expect(conventions.METRIC_DEADLETTER).toBe('mcp.deadletter.count');
    expect(conventions.ATTR_CIRCUIT_TO_STATE).toBe('to_state');
    expect(conventions.ATTR_ERROR_TYPE).toBe('error.type');
  });
});
