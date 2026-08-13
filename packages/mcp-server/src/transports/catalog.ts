import { buildCatalogServer } from '@discord-mcp/core';
import type { Transport } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';

/**
 * The catalog server deliberately has no Discord runtime dependencies. Keep
 * this boundary small so schema discovery cannot load the normal REST,
 * Gateway, profile, configuration, or OpenTelemetry path.
 */
export interface CatalogStartOptions {
  /** A supplied transport is useful for in-process integration tests. */
  transport?: Transport;
  /** Disable process signal hooks in tests that own the process lifecycle. */
  registerSignalHandlers?: boolean;
}

/**
 * Start the catalog-only MCP server over stdio.
 *
 * No config is loaded here: in particular, DISCORD_TOKEN, GATEWAY, and
 * OTEL_ENABLED are intentionally irrelevant to this transport.
 */
export async function startCatalog(opts: CatalogStartOptions = {}): Promise<void> {
  const { server, auditSink } = await buildCatalogServer();
  const transport = opts.transport ?? new StdioServerTransport();
  await server.connect(transport);

  const shutdown = async (signal: string): Promise<void> => {
    try {
      await server.close();
      await auditSink.shutdown?.();
      process.exit(0);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`discord-mcp catalog failed to close on ${signal}: ${message}\n`);
      process.exit(1);
    }
  };

  if (opts.registerSignalHandlers !== false) {
    process.once('SIGINT', () => void shutdown('SIGINT'));
    process.once('SIGTERM', () => void shutdown('SIGTERM'));
  }
}
