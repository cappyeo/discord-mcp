import { type Resource, resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import type { Config } from '../config.js';

// Static - the public tool registry currently contains 193 tools.
const PLAN8_TOOL_COUNT = '193';

// Inlined since these come from `/incubating` in semconv 1.34 and we'd
// rather not couple to an unstable subpath.
const ATTR_DEPLOYMENT_ENVIRONMENT_NAME = 'deployment.environment.name';
const ATTR_MCP_TRANSPORT = 'mcp.transport';
const ATTR_MCP_TOOL_COUNT = 'mcp.tool_count';

/**
 * Builds the OpenTelemetry Resource describing the discord-mcp service.
 * Used by the SDK in mcp-server (Phase A.1) so every span/metric is
 * tagged with consistent service identity.
 */
export function buildResource(config: Config): Resource {
  const env = process.env.NODE_ENV ?? 'development';
  return resourceFromAttributes({
    [ATTR_SERVICE_NAME]: config.OTEL_SERVICE_NAME,
    [ATTR_SERVICE_VERSION]: config.OTEL_SERVICE_VERSION,
    [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: env,
    [ATTR_MCP_TRANSPORT]: 'stdio',
    [ATTR_MCP_TOOL_COUNT]: PLAN8_TOOL_COUNT,
  });
}
