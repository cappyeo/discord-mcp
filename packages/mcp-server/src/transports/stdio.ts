import {
  buildPolicy,
  buildServer,
  createGatewayClient,
  createLogger,
  type GatewayClient,
  loadConfig,
  wrapRestWithResilience,
} from '@discord-mcp/core';
import { REST } from '@discordjs/rest';
import type { Transport } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import type { OtelHandle } from '../otel.js';

/**
 * @param opts.transport Transport to connect the MCP server to. Defaults to a
 *   real `StdioServerTransport`; tests pass an in-memory pair so the whole
 *   boot chain runs for real.
 * @param opts.registerSignalHandlers Register the SIGINT/SIGTERM shutdown
 *   hooks. Defaults to true; tests disable it because the handlers call
 *   `process.exit(0)` and would outlive the test process.
 */
export async function startStdio(
  opts: { transport?: Transport; registerSignalHandlers?: boolean } = {},
): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config);

  // Boot OTel BEFORE buildServer so global tracer/meter providers exist
  // by the time the telemetry middleware fetches them. Returns null when
  // OTEL_ENABLED is false (default), preserving v0.7.0 behavior.
  const otel: OtelHandle | null = config.OTEL_ENABLED
    ? (await import('../otel.js')).startOtel(config)
    : null;
  if (otel !== null) {
    logger.info({ otel: 'enabled' }, 'OpenTelemetry SDK started');
  }

  // Cockatiel is the single retry owner: reject queued/pre-emptive 429s too,
  // otherwise discord.js can wait past our 30s operation timeout before it
  // gives Cockatiel a chance to honor Retry-After. Keep the SDK retry count off.
  const baseRest = new REST({ version: '10', retries: 0, rejectOnRateLimit: () => true }).setToken(
    // Discord REST does not want the "Bot " prefix here - discord.js's REST adds it.
    config.DISCORD_TOKEN.startsWith('Bot ') ? config.DISCORD_TOKEN.slice(4) : config.DISCORD_TOKEN,
  );

  // Wrap the rate-limit-queue-aware REST in cockatiel's resilience policy
  // (timeout + retry-on-DiscordRetryableError + circuit breaker + bulkhead).
  // Passing `logger` enables circuit/bulkhead/dead-letter hook logs.
  // `circuitHalfOpenAfterMs` is forwarded so CircuitOpenError carries the
  // configured wait hint to the agent.
  const rest = wrapRestWithResilience(baseRest, buildPolicy(config, logger), {
    circuitHalfOpenAfterMs: config.MCP_CIRCUIT_HALF_OPEN_AFTER_MS,
  });

  const { server, registeredTools, notifyResource, subscriptions, auditSink } = await buildServer({
    rest,
    logger,
    config,
  });

  let gatewayClient: GatewayClient | null = null;
  if (config.GATEWAY) {
    gatewayClient = createGatewayClient({
      token: config.DISCORD_TOKEN.startsWith('Bot ')
        ? config.DISCORD_TOKEN.slice(4)
        : config.DISCORD_TOKEN,
      registry: subscriptions,
      notifyResource,
    });
    try {
      await gatewayClient.start();
      logger.info({ gateway: 'enabled' }, 'Discord Gateway connected');
    } catch (e) {
      logger.warn(
        { err: e instanceof Error ? e.message : String(e) },
        'Discord Gateway failed to start - continuing in REST-only mode',
      );
      gatewayClient = null;
    }
  }

  logger.info(
    { tools: registeredTools.length, gateway: gatewayClient !== null },
    'discord-mcp ready (stdio)',
  );

  const transport = opts.transport ?? new StdioServerTransport();
  await server.connect(transport);

  // Graceful shutdown.
  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'shutting down');
    if (gatewayClient !== null) {
      try {
        await gatewayClient.stop();
      } catch (e) {
        logger.warn({ err: e instanceof Error ? e.message : String(e) }, 'gateway stop failed');
      }
    }
    await server.close();
    // Flush audit sink before OTel - sinks may write JSON lines to
    // disk that we want persisted even if OTel teardown stalls.
    if (auditSink.shutdown !== undefined) {
      try {
        await auditSink.shutdown();
      } catch (e) {
        logger.warn(
          { err: e instanceof Error ? e.message : String(e) },
          'audit sink shutdown failed',
        );
      }
    }
    if (otel !== null) {
      try {
        await otel.shutdown();
      } catch (e) {
        logger.warn({ err: e instanceof Error ? e.message : String(e) }, 'otel shutdown failed');
      }
    }
    process.exit(0);
  };
  if (opts.registerSignalHandlers !== false) {
    process.on('SIGINT', () => void shutdown('SIGINT'));
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
  }
}
