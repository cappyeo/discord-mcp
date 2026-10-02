import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const entry = new URL('../../../mcp-core/dist/index.js', import.meta.url).href;
const modes = ['import', 'catalog', 'progressive'];

// Fresh Node processes with a warm filesystem cache; no credentials or network I/O.
if (process.argv[2] === '--sample') {
  const mode = process.argv[3];
  assert.ok(modes.includes(mode));
  global.gc();
  const initial = process.memoryUsage();
  const started = performance.now();
  const core = await import(entry);
  const importMs = performance.now() - started;
  let built;
  if (mode === 'catalog') built = await core.buildCatalogServer();
  if (mode === 'progressive') {
    const noop = () => undefined;
    const logger = {
      trace: noop,
      debug: noop,
      info: noop,
      warn: noop,
      error: noop,
      fatal: noop,
      child() {
        return this;
      },
    };
    const config = core.loadConfig({
      DISCORD_TOKEN: `Bot ${'a'.repeat(60)}`,
      LOG_LEVEL: 'fatal',
      GATEWAY: 'false',
      OTEL_ENABLED: 'false',
      MCP_AUDIT_ENABLED: 'false',
      MCP_TOOL_SURFACE: 'progressive',
      MCP_WRITE_MODE: 'preview',
    });
    built = await core.buildServer({
      rest: {},
      logger,
      config,
      transport: 'http',
      auditSink: { write: async () => undefined },
    });
  }
  const readyMs = performance.now() - started;
  global.gc();
  const ready = process.memoryUsage();
  await built?.server.close();
  process.stdout.write(
    `${JSON.stringify({
      mode,
      import_ms: importMs,
      ready_ms: readyMs,
      tool_count: built?.registeredTools.length ?? null,
      initial_heap_bytes: initial.heapUsed,
      ready_heap_bytes: ready.heapUsed,
      heap_delta_bytes: ready.heapUsed - initial.heapUsed,
      initial_rss_bytes: initial.rss,
      ready_rss_bytes: ready.rss,
      rss_delta_bytes: ready.rss - initial.rss,
    })}\n`,
  );
} else {
  assert.equal(process.argv.length, 2, 'Usage: node runtime-performance.mjs > output.json');
  const samples = [];
  for (const mode of modes) {
    for (let run = 0; run < 9; run += 1) {
      const started = performance.now();
      const child = spawnSync(
        process.execPath,
        ['--expose-gc', fileURLToPath(import.meta.url), '--sample', mode],
        {
          cwd: root,
          encoding: 'utf8',
          timeout: 30_000,
          env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH },
        },
      );
      assert.equal(child.status, 0, child.stderr || child.error?.message);
      samples.push({ ...JSON.parse(child.stdout), wall_ms: performance.now() - started });
    }
  }
  const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const summary = modes.map((mode) => {
    const rows = samples.filter((sample) => sample.mode === mode);
    return {
      mode,
      runs: rows.length,
      tool_count: rows[0].tool_count,
      median_import_ms: median(rows.map((row) => row.import_ms)),
      median_ready_ms: median(rows.map((row) => row.ready_ms)),
      median_wall_ms: median(rows.map((row) => row.wall_ms)),
      median_ready_heap_bytes: median(rows.map((row) => row.ready_heap_bytes)),
      median_ready_rss_bytes: median(rows.map((row) => row.ready_rss_bytes)),
      median_heap_delta_bytes: median(rows.map((row) => row.heap_delta_bytes)),
    };
  });
  process.stdout.write(
    `${JSON.stringify(
      {
        schema_version: 'discord-mcp.runtime-performance.v1',
        captured_at: new Date().toISOString(),
        node: process.version,
        platform: process.platform,
        scope: 'Fresh processes; warm filesystem cache; no network',
        summary,
        samples,
      },
      null,
      2,
    )}\n`,
  );
}
