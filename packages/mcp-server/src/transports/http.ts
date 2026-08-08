import { timingSafeEqual } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import {
  buildPolicy,
  buildServer,
  createAuditSink,
  createLogger,
  loadConfig,
  verifyExpectedBotIdentity,
  wrapRestWithResilience,
} from '@discord-mcp/core';
import { REST } from '@discordjs/rest';
import {
  localhostHostValidation,
  localhostOriginValidation,
  toNodeHandler,
} from '@modelcontextprotocol/node';
import { createMcpHandler } from '@modelcontextprotocol/server';
import type { OtelHandle } from '../otel.js';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 3000;

export interface StartHttpOptions {
  host?: string;
  port?: number;
  registerSignalHandlers?: boolean;
}

function hasValidBearerToken(authorization: string | undefined, expectedToken: string): boolean {
  if (authorization === undefined || !authorization.startsWith('Bearer ')) return false;

  const suppliedToken = Buffer.from(authorization.slice('Bearer '.length));
  const expected = Buffer.from(expectedToken);
  return suppliedToken.length === expected.length && timingSafeEqual(suppliedToken, expected);
}

/**
 * Starts a stateless Streamable HTTP MCP endpoint at `/mcp`.
 *
 * Stateless requests make the endpoint safe to place behind a load balancer
 * and let OpenAI's Responses API import and call tools without sharing MCP
 * session state between authenticated clients.
 */
export async function startHttp(options: StartHttpOptions = {}): Promise<Server> {
  const config = loadConfig();
  const accessToken = config.DISCORD_MCP_ACCESS_TOKEN;
  if (accessToken === undefined) {
    throw new Error('DISCORD_MCP_ACCESS_TOKEN is required for the HTTP transport.');
  }
  const logger = createLogger(config);

  const baseRest = new REST({ version: '10', retries: 0 }).setToken(
    config.DISCORD_TOKEN.startsWith('Bot ') ? config.DISCORD_TOKEN.slice(4) : config.DISCORD_TOKEN,
  );
  const rest = wrapRestWithResilience(baseRest, buildPolicy(config, logger), {
    circuitHalfOpenAfterMs: config.MCP_CIRCUIT_HALF_OPEN_AFTER_MS,
  });
  await verifyExpectedBotIdentity(rest, config.DISCORD_EXPECTED_BOT_ID);
  const otel: OtelHandle | null = config.OTEL_ENABLED
    ? (await import('../otel.js')).startOtel(config)
    : null;
  if (otel !== null) {
    logger.info({ otel: 'enabled' }, 'OpenTelemetry SDK started');
  }

  // The v2 handler builds a fresh MCP server for every request. Audit output,
  // however, is process-scoped so file/OTLP sinks are opened and flushed once.
  const auditSink = createAuditSink(config);
  const reportMcpError = (error: Error): void => {
    logger.error({ err: error }, 'MCP HTTP request failed');
  };
  const mcpHandler = createMcpHandler(
    async () =>
      (
        await buildServer({
          rest,
          logger,
          config,
          transport: 'http',
          auditSink,
        })
      ).server,
    {
      // OpenAI and existing MCP clients still use 2025-era Streamable HTTP.
      // The same endpoint also serves the stateless MCP 2026 protocol.
      legacy: 'stateless',
      onerror: reportMcpError,
    },
  );
  const handleMcpRequest = toNodeHandler(mcpHandler, { onerror: reportMcpError });

  const host = options.host ?? DEFAULT_HOST;
  const port = options.port ?? DEFAULT_PORT;
  const isLoopbackHost = host === '127.0.0.1' || host === 'localhost' || host === '::1';
  const validateHost = isLoopbackHost ? localhostHostValidation() : undefined;
  const validateOrigin = isLoopbackHost ? localhostOriginValidation() : undefined;

  const server = createServer(async (req, res) => {
    if (req.url === undefined || new URL(req.url, 'http://localhost').pathname !== '/mcp') {
      res.writeHead(404).end();
      return;
    }

    if (!hasValidBearerToken(req.headers.authorization, accessToken)) {
      res.writeHead(401, { 'WWW-Authenticate': 'Bearer' }).end();
      return;
    }

    // Protect the default localhost deployment from DNS rebinding. Public
    // deployments remain responsible for Host/Origin policy at their proxy.
    if (validateHost !== undefined && !validateHost(req, res)) return;
    if (validateOrigin !== undefined && !validateOrigin(req, res)) return;

    // The SDK's structural Node request type marks `method` as optional while
    // IncomingMessage spells it as `string | undefined`; the runtime shape is
    // the native object the adapter expects.
    await handleMcpRequest(req as never, res);
  });

  let cleanupPromise: Promise<void> | undefined;
  const cleanup = (): Promise<void> => {
    cleanupPromise ??= (async () => {
      try {
        await mcpHandler.close();
      } catch (error) {
        logger.warn(
          { err: error instanceof Error ? error.message : String(error) },
          'MCP HTTP handler shutdown failed',
        );
      }
      if (auditSink.shutdown !== undefined) {
        try {
          await auditSink.shutdown();
        } catch (error) {
          logger.warn(
            { err: error instanceof Error ? error.message : String(error) },
            'audit sink shutdown failed',
          );
        }
      }
      if (otel !== null) {
        try {
          await otel.shutdown();
        } catch (error) {
          logger.warn(
            { err: error instanceof Error ? error.message : String(error) },
            'otel shutdown failed',
          );
        }
      }
    })();
    return cleanupPromise;
  };
  server.once('close', () => void cleanup());

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.off('error', reject);
        resolve();
      });
    });
  } catch (error) {
    await cleanup();
    throw error;
  }

  logger.info({ host, port }, 'discord-mcp ready (http)');

  if (options.registerSignalHandlers !== false) {
    const shutdown = async (signal: string): Promise<void> => {
      logger.info({ signal }, 'shutting down');
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await cleanup();
      process.exit(0);
    };
    process.on('SIGINT', () => void shutdown('SIGINT'));
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
  }

  return server;
}
