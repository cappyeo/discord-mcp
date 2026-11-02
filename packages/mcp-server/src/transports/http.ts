import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import {
  buildPolicy,
  buildServer,
  createAuditSink,
  createLogger,
  createRuntimeAccessResolver,
  FilePayloadApprovalLedger,
  loadConfig,
  PayloadApprovalLedger,
  verifyExpectedBotIdentity,
  wrapRestWithResilience,
} from '@discord-mcp/core';
import { REST } from '@discordjs/rest';
import {
  localhostHostValidation,
  localhostOriginValidation,
  toNodeHandler,
} from '@modelcontextprotocol/node';
import { type AuthInfo, createMcpHandler } from '@modelcontextprotocol/server';
import { recordBlueprintActivity } from '../lib/activity.js';
import { createOAuthCallerVerifier, type DiscordHttp, OAuthCallerRejected } from '../lib/oauth2.js';
import type { OtelHandle } from '../otel.js';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 3000;

class RequestBodyTooLarge extends Error {}

/** `toNodeHandler` reads `req.auth`; Node's own request type does not declare it. */
type AuthenticatedRequest = IncomingMessage & { auth?: AuthInfo };

/** Replay of a request whose body was already read and bounded. */
function replayRequest(req: AuthenticatedRequest, body: Buffer): IncomingMessage {
  const replay = Readable.from(body.byteLength === 0 ? [] : [body]);
  return Object.assign(replay, {
    method: req.method,
    url: req.url,
    headers: req.headers,
    auth: req.auth,
  }) as unknown as IncomingMessage;
}

export interface StartHttpOptions {
  host?: string;
  port?: number;
  registerSignalHandlers?: boolean;
  /**
   * HTTP implementation for every Discord request this transport makes
   * (bot REST, identity/access evidence, OAuth2 verification). Real
   * deployments use the default; suites point it at a loopback stub.
   */
  makeRequest?: DiscordHttp;
}

/** The bearer credential from an `Authorization` header, if it is well formed. */
export function bearerToken(authorization: string | undefined): string | undefined {
  if (authorization === undefined) return undefined;
  const separator = authorization.indexOf(' ');
  if (separator < 1 || authorization.slice(0, separator).toLowerCase() !== 'bearer')
    return undefined;
  let tokenStart = separator + 1;
  while (authorization[tokenStart] === ' ') tokenStart += 1;
  if (tokenStart >= authorization.length) return undefined;
  return authorization.slice(tokenStart);
}

export function hasValidBearerToken(
  authorization: string | undefined,
  expectedToken: string,
): boolean {
  const suppliedToken = bearerToken(authorization);
  if (suppliedToken === undefined) return false;
  const supplied = Buffer.from(suppliedToken);
  const expected = Buffer.from(expectedToken);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

async function readRequestBody(
  req: IncomingMessage,
  maxBytes: number,
): Promise<Buffer | undefined> {
  const method = req.method?.toUpperCase();
  if (method === 'GET' || method === 'HEAD') return undefined;

  const declaredLength = req.headers['content-length'];
  if (
    typeof declaredLength === 'string' &&
    /^\d+$/.test(declaredLength) &&
    Number(declaredLength) > maxBytes
  ) {
    throw new RequestBodyTooLarge();
  }

  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    totalBytes += buffer.byteLength;
    if (totalBytes > maxBytes) throw new RequestBodyTooLarge();
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, totalBytes);
}

function rejectAndClose(
  req: IncomingMessage,
  res: ServerResponse,
  status: number,
  headers: Record<string, string> = {},
): void {
  // Closing prevents a partially unread body from contaminating keep-alive.
  res.writeHead(status, { ...headers, Connection: 'close' });
  res.end(() => {
    if (!req.destroyed) req.destroy();
  });
}

function requestDeclaresBody(req: IncomingMessage): boolean {
  const contentLength = req.headers['content-length'];
  const lengths = Array.isArray(contentLength) ? contentLength : [contentLength];
  if (
    lengths.some((value) => {
      if (value === undefined || !/^\d+$/.test(value)) return false;
      return Number(value) > 0;
    })
  ) {
    return true;
  }
  return req.headers['transfer-encoding'] !== undefined;
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
  // Optional bearer protection. When DISCORD_MCP_ACCESS_TOKEN is unset the
  // endpoint is open and must be gated at the networking layer (reverse proxy,
  // VPN, or Docker publish rule) when exposing the server directly.
  const accessToken = config.DISCORD_MCP_ACCESS_TOKEN;
  // In `oauth2` mode the bearer is a Discord user token instead of the shared
  // deployment secret. Every authorizeable Discord account is accepted; that
  // user's own Discord permissions bound what they can do.
  const oauth2Mode = config.MCP_AUTH_MODE === 'oauth2';
  const verifyOAuthCaller = oauth2Mode
    ? createOAuthCallerVerifier({
        ...(config.DISCORD_EXPECTED_BOT_ID === undefined
          ? {}
          : { expectedBotId: config.DISCORD_EXPECTED_BOT_ID }),
        ...(options.makeRequest === undefined ? {} : { makeRequest: options.makeRequest }),
      })
    : undefined;
  const logger = createLogger(config);

  // Keep Cockatiel as the single retry owner. Reject queued/pre-emptive 429s
  // so the SDK cannot wait past our 30s operation timeout before Retry-After
  // reaches Cockatiel; `retries: 0` prevents a second retry loop.
  const baseRest = new REST({
    version: '10',
    retries: 0,
    rejectOnRateLimit: () => true,
    ...(options.makeRequest === undefined ? {} : { makeRequest: options.makeRequest }),
  }).setToken(
    config.DISCORD_TOKEN.startsWith('Bot ') ? config.DISCORD_TOKEN.slice(4) : config.DISCORD_TOKEN,
  );
  const rest = wrapRestWithResilience(baseRest, buildPolicy(config, logger), {
    circuitHalfOpenAfterMs: config.MCP_CIRCUIT_HALF_OPEN_AFTER_MS,
  });
  await verifyExpectedBotIdentity(rest, config.DISCORD_EXPECTED_BOT_ID);
  // OAuth2 mode exists to bound callers by their own Discord permissions, so it
  // always enforces regardless of MCP_ACCESS_MODE; `advisory` would execute the
  // very calls the evidence cannot prove.
  const accessMode = oauth2Mode ? 'enforce' : config.MCP_ACCESS_MODE;
  const runtimeAccessResolver =
    accessMode === 'advisory'
      ? undefined
      : createRuntimeAccessResolver({
          rest,
          ...(config.DISCORD_EXPECTED_BOT_ID === undefined
            ? {}
            : { expectedBotId: config.DISCORD_EXPECTED_BOT_ID }),
          // Streamable HTTP is REST-only here; no privileged Gateway intents
          // are active, so intent-requiring calls stay non-admissible.
          runtimeIntents: { GUILD_MEMBERS: 'missing', MESSAGE_CONTENT: 'missing' },
        });
  const otel: OtelHandle | null = config.OTEL_ENABLED
    ? (await import('../otel.js')).startOtel(config)
    : null;
  if (otel !== null) {
    logger.info({ otel: 'enabled' }, 'OpenTelemetry SDK started');
  }

  // The v2 handler builds a fresh MCP server for every request. Audit output,
  // however, is process-scoped so file/OTLP sinks are opened and flushed once.
  const auditSink = createAuditSink(
    config,
    otel?.auditEmitter === undefined ? {} : { otlpEmitter: otel.auditEmitter },
  );
  // HTTP builds a fresh MCP server per request. Keep approval state at the
  // process/deployment boundary so preview and one-time execution can occur
  // across two stateless HTTP exchanges without sharing Discord credentials.
  const payloadApprovalLedger =
    config.MCP_APPROVAL_STATE_DIR !== undefined && config.MCP_APPROVAL_HMAC_KEY !== undefined
      ? new FilePayloadApprovalLedger({
          directory: config.MCP_APPROVAL_STATE_DIR,
          secret: config.MCP_APPROVAL_HMAC_KEY,
        })
      : new PayloadApprovalLedger();
  const reportMcpError = (error: Error): void => {
    logger.error({ err: error }, 'MCP HTTP request failed');
  };
  const mcpHandler = createMcpHandler(
    async (context) => {
      // `authInfo.token` is the verified credential the caller passed; in
      // OAuth2 mode its identity is already resolved and re-verified per
      // request by the gate above, so the build only needs the Discord user.
      const callerPrincipalId = context.authInfo?.extra?.principalId;
      return (
        await buildServer({
          rest,
          logger,
          // The gate below may force enforcement; build with that effective
          // mode so the middleware chain matches the transport's policy.
          config:
            accessMode === config.MCP_ACCESS_MODE
              ? config
              : { ...config, MCP_ACCESS_MODE: accessMode },
          transport: 'http',
          // This stateless transport has no Gateway resource-update publisher.
          enableResourceSubscriptions: false,
          auditSink,
          payloadApprovalLedger,
          ...(runtimeAccessResolver === undefined ? {} : { runtimeAccessResolver }),
          ...(typeof callerPrincipalId === 'string' ? { callerPrincipalId } : {}),
          ...(runtimeAccessResolver === undefined
            ? {}
            : {
                onRuntimeAccessWarning: (message: string) =>
                  logger.warn({ access: 'runtime' }, message),
              }),
          onBlueprintLifecycle: recordBlueprintActivity,
        })
      ).server;
    },
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
  let inFlight = 0;

  const server = createServer(async (req, res) => {
    const pathname =
      req.url === undefined ? undefined : new URL(req.url, 'http://localhost').pathname;
    if (pathname !== '/mcp' && pathname !== '/healthz') {
      res.writeHead(404).end();
      return;
    }

    // Readiness carries no data and infrastructure probes have no Discord
    // account, so OAuth2 mode leaves it unauthenticated (as the default token
    // mode does when no token is configured). /mcp always needs a caller.
    let callerId: string | undefined;
    if (verifyOAuthCaller !== undefined) {
      if (pathname !== '/healthz') {
        const token = bearerToken(req.headers.authorization);
        if (token === undefined) {
          res.writeHead(401, { 'WWW-Authenticate': 'Bearer' }).end();
          return;
        }
        try {
          callerId = (await verifyOAuthCaller(token)).id;
        } catch (error) {
          const status = error instanceof OAuthCallerRejected ? error.status : 401;
          res
            .writeHead(status, {
              'WWW-Authenticate': 'Bearer',
              'Content-Type': 'application/json; charset=utf-8',
            })
            .end(
              JSON.stringify({
                error: status === 401 ? 'invalid_token' : 'access_denied',
                error_description: error instanceof Error ? error.message : 'Unauthorized',
              }),
            );
          return;
        }
      }
    } else if (
      accessToken !== undefined &&
      !hasValidBearerToken(req.headers.authorization, accessToken)
    ) {
      res.writeHead(401, { 'WWW-Authenticate': 'Bearer' }).end();
      return;
    }

    // Protect the default localhost deployment from DNS rebinding. Public
    // deployments remain responsible for Host/Origin policy at their proxy.
    if (validateHost !== undefined && !validateHost(req, res)) return;
    if (validateOrigin !== undefined && !validateOrigin(req, res)) return;

    if (pathname === '/healthz') {
      if (req.method?.toUpperCase() !== 'GET') {
        rejectAndClose(req, res, 404);
        return;
      }
      // A health probe has no request payload. Close the connection rather
      // than replying while unread bytes could be interpreted as a second
      // request on the same keep-alive socket.
      if (requestDeclaresBody(req)) {
        rejectAndClose(req, res, 400);
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    if (inFlight >= config.MCP_HTTP_MAX_IN_FLIGHT) {
      rejectAndClose(req, res, 503, { 'Retry-After': '1' });
      return;
    }

    inFlight += 1;
    try {
      let body: Buffer | undefined;
      try {
        body = await readRequestBody(req, config.MCP_HTTP_MAX_BODY_BYTES);
      } catch (error) {
        if (error instanceof RequestBodyTooLarge) {
          rejectAndClose(req, res, 413);
        } else {
          res.destroy(error instanceof Error ? error : undefined);
        }
        return;
      }

      // The SDK forwards `req.auth` to the factory as `authInfo`; carry the
      // already-verified Discord user there so each per-request server knows
      // whose permissions authorize its tool calls. The body was read above,
      // so only the replay copy reaches the adapter.
      const authenticatedReq = req as AuthenticatedRequest; // adapter reads req.auth
      if (callerId !== undefined) {
        authenticatedReq.auth = {
          token: bearerToken(req.headers.authorization) ?? '',
          clientId: config.DISCORD_EXPECTED_BOT_ID ?? '',
          scopes: [],
          extra: { principalId: callerId },
        };
      }

      // The SDK adapter currently buffers the incoming stream without a byte
      // ceiling. Replay only the body we have already bounded above.
      await handleMcpRequest(
        body === undefined
          ? (authenticatedReq as never)
          : (replayRequest(authenticatedReq, body) as never),
        res,
      );
    } finally {
      inFlight -= 1;
    }
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
