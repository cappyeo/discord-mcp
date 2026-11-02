import {
  type BuildServerDeps,
  type BuildServerResult,
  buildPolicy,
  buildServer,
  createAuditSink,
  createGatewayClient,
  createLogger,
  createRuntimeAccessResolver,
  eventBridgeFromConfig,
  FilePayloadApprovalLedger,
  type GatewayClient,
  loadConfig,
  wrapRestWithResilience,
} from '@discord-mcp/core';
import { REST } from '@discordjs/rest';
import type { Transport } from '@modelcontextprotocol/server';
import { type StdioServerHandle, serveStdio } from '@modelcontextprotocol/server/stdio';
import { recordBlueprintActivity } from '../lib/activity.js';
import type { OtelHandle } from '../otel.js';

/**
 * @param opts.transport Transport to connect the MCP server to. Defaults to a
 *   real `StdioServerTransport`; tests pass an in-memory pair so the whole
 *   boot chain runs for real.
 * @param opts.registerSignalHandlers Register process shutdown hooks for real
 *   stdio. Defaults to true; supplied transports never exit their host process.
 */
export async function startStdio(
  opts: { transport?: Transport; registerSignalHandlers?: boolean } = {},
): Promise<void> {
  const config = loadConfig();
  const eventBridge = eventBridgeFromConfig(config);
  const logger = createLogger(config);
  const ownsProcess = opts.transport === undefined && opts.registerSignalHandlers !== false;
  let stdioHandle: StdioServerHandle | undefined;
  let cleanup = async (): Promise<void> => {};
  let shutdownPromise: Promise<void> | undefined;
  let resourcesReady!: () => void;
  const readyForCleanup = new Promise<void>((resolve) => {
    resourcesReady = resolve;
  });
  const requestShutdown = (reason: string, exit = ownsProcess): Promise<void> => {
    // Defer cleanup so the promise is assigned before server.close() can
    // synchronously re-enter through transport.onclose.
    shutdownPromise ??= Promise.resolve().then(async () => {
      logger.info({ signal: reason }, 'shutting down');
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          readyForCleanup.then(() => cleanup()),
          new Promise<void>((resolve) => {
            // Start the deadline on the first shutdown request, even if boot
            // has not reached Gateway/server construction yet.
            timeout = setTimeout(() => {
              logger.warn({ timeoutMs: 5_000 }, 'shutdown timed out');
              resolve();
            }, 5_000);
            timeout.unref();
          }),
        ]);
      } catch (error) {
        logger.warn(
          { err: error instanceof Error ? error.message : String(error) },
          'shutdown failed',
        );
      } finally {
        clearTimeout(timeout);
        removeProcessHooks();
      }
      if (exit && ownsProcess) process.exit(0);
    });
    return shutdownPromise;
  };
  const onSigint = () => void requestShutdown('SIGINT');
  const onSigterm = () => void requestShutdown('SIGTERM');
  const onInputEnd = () => void requestShutdown('stdin closed');
  const onInputError = () => void requestShutdown('stdin error');
  const onOutputError = () => void requestShutdown('stdout closed');
  const removeProcessHooks = (): void => {
    if (ownsProcess) {
      process.off('SIGINT', onSigint);
      process.off('SIGTERM', onSigterm);
      process.stdin.off('end', onInputEnd);
      process.stdin.off('close', onInputEnd);
      process.stdin.off('error', onInputError);
      process.stdout.off('error', onOutputError);
    }
  };

  if (ownsProcess) {
    process.on('SIGINT', onSigint);
    process.on('SIGTERM', onSigterm);
    process.stdin.on('end', onInputEnd);
    process.stdin.on('close', onInputEnd);
    process.stdin.on('error', onInputError);
    process.stdout.on('error', onOutputError);
    if (process.stdin.readableEnded || process.stdin.destroyed) {
      void requestShutdown('stdin already closed');
    }
  }

  // Boot OTel BEFORE buildServer so global tracer/meter providers exist
  // by the time the telemetry middleware fetches them. Returns null when
  // OTEL_ENABLED is false (default), preserving v0.7.0 behavior.
  const otel: OtelHandle | null = config.OTEL_ENABLED
    ? (await import('../otel.js')).startOtel(config)
    : null;
  if (otel !== null) {
    logger.info({ otel: 'enabled' }, 'OpenTelemetry SDK started');
  }

  // Core owns the audit contract; the server injects the process-scoped OTel
  // logs adapter only when `MCP_AUDIT_SINK=otlp` is actually configured.
  const configuredAuditSink = createAuditSink(
    config,
    otel?.auditEmitter === undefined ? {} : { otlpEmitter: otel.auditEmitter },
  );

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

  const payloadApprovalLedger =
    config.MCP_APPROVAL_STATE_DIR !== undefined && config.MCP_APPROVAL_HMAC_KEY !== undefined
      ? new FilePayloadApprovalLedger({
          directory: config.MCP_APPROVAL_STATE_DIR,
          secret: config.MCP_APPROVAL_HMAC_KEY,
        })
      : undefined;

  const runtimeAccessResolver =
    config.MCP_ACCESS_MODE === 'advisory'
      ? undefined
      : createRuntimeAccessResolver({
          rest,
          ...(config.DISCORD_EXPECTED_BOT_ID === undefined
            ? {}
            : { expectedBotId: config.DISCORD_EXPECTED_BOT_ID }),
          // The current Gateway client intentionally requests no privileged
          // intents. Keep that runtime fact separate from application flags.
          runtimeIntents: { GUILD_MEMBERS: 'missing', MESSAGE_CONTENT: 'missing' },
        });

  const buildServerDeps: BuildServerDeps = {
    rest,
    logger,
    config,
    ...(eventBridge ? { eventBridge } : {}),
    enableResourceSubscriptions: true,
    auditSink: configuredAuditSink,
    ...(runtimeAccessResolver === undefined ? {} : { runtimeAccessResolver }),
    ...(payloadApprovalLedger === undefined ? {} : { payloadApprovalLedger }),
    ...(runtimeAccessResolver === undefined
      ? {}
      : {
          onRuntimeAccessWarning: (message: string) => logger.warn({ access: 'runtime' }, message),
        }),
    onBlueprintLifecycle: recordBlueprintActivity,
  };
  // Keep one eagerly built instance for the injected transport path and for
  // boot validation. Real stdio gets a fresh instance for every SDK factory
  // call, including a discarded modern discover probe before legacy fallback.
  const initialBuild = await buildServer(buildServerDeps);
  const serverBuilds: BuildServerResult[] = [initialBuild];
  let activeBuild = initialBuild;
  const usedBuilds = new Set<BuildServerResult>();
  const gatewayRegistry = {
    has: (uri: string) => activeBuild.subscriptions.has(uri),
    matchPattern: (pattern: RegExp) => activeBuild.subscriptions.matchPattern(pattern),
  };
  const notifyResource = (uri: string): Promise<void> => activeBuild.notifyResource(uri);
  const { server, registeredTools, auditSink } = activeBuild;

  let gatewayClient: GatewayClient | null = null;
  if (config.GATEWAY) {
    gatewayClient = createGatewayClient({
      token: config.DISCORD_TOKEN.startsWith('Bot ')
        ? config.DISCORD_TOKEN.slice(4)
        : config.DISCORD_TOKEN,
      registry: gatewayRegistry as typeof activeBuild.subscriptions,
      notifyResource,
    });
  }

  const closeResource = async (name: string, close: () => Promise<unknown>): Promise<void> => {
    try {
      await close();
    } catch (e) {
      logger.warn({ err: e instanceof Error ? e.message : String(e) }, `${name} shutdown failed`);
    }
  };
  cleanup = async () => {
    // A stalled Gateway must not block closing MCP or flushing audit data.
    await Promise.all([
      closeResource('server', async () => {
        if (stdioHandle !== undefined) {
          await stdioHandle.close();
          await Promise.all(
            serverBuilds
              .filter((build) => !usedBuilds.has(build))
              .map((build) => build.server.close()),
          );
          return;
        }
        await server.close();
      }),
      closeResource('gateway', async () => gatewayClient?.stop()),
      (async () => {
        // Flush audit before OTel because an audit sink may use its exporter.
        await closeResource('audit sink', async () => auditSink.shutdown?.());
        await closeResource('otel', async () => otel?.shutdown());
      })(),
    ]);
  };
  resourcesReady();
  if (shutdownPromise !== undefined) {
    await shutdownPromise;
    return;
  }

  try {
    if (opts.transport !== undefined) {
      // Protocol.connect preserves an existing transport callback. Install it
      // before connect so a close during transport.start() cannot be missed.
      const transportOnClose = opts.transport.onclose;
      opts.transport.onclose = () => {
        transportOnClose?.();
        void requestShutdown('transport closed');
      };
      await server.connect(opts.transport);
    } else {
      stdioHandle = serveStdio(
        async ({ era }) => {
          const build = await buildServer({
            ...buildServerDeps,
            enableResourceSubscriptions: era === 'legacy',
          });
          serverBuilds.push(build);
          activeBuild = build;
          usedBuilds.add(build);
          return build.server;
        },
        {
          legacy: 'serve',
          onerror: (error) => logger.error({ err: error }, 'stdio MCP transport failed'),
        },
      );
    }
  } catch (error) {
    await requestShutdown('startup failure', false);
    throw error;
  }
  if (shutdownPromise !== undefined) {
    await shutdownPromise;
    return;
  }

  // Listen to stdin before awaiting Gateway so a disconnected host can stop
  // a pending Gateway connection instead of leaving an unresponsive child.
  if (gatewayClient !== null) {
    try {
      await gatewayClient.start();
      logger.info({ gateway: 'enabled' }, 'Discord Gateway connected');
    } catch (e) {
      logger.warn(
        { err: e instanceof Error ? e.message : String(e) },
        'Discord Gateway failed to start - continuing in REST-only mode',
      );
      if (shutdownPromise === undefined) {
        await closeResource('gateway', () => gatewayClient!.stop());
        gatewayClient = null;
      }
    }
  }
  if (shutdownPromise !== undefined) {
    await shutdownPromise;
    return;
  }
  logger.info(
    { tools: registeredTools.length, gateway: gatewayClient !== null },
    'discord-mcp ready (stdio)',
  );
}
