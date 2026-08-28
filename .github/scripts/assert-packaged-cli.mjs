/**
 * Install the publishable tarballs into an empty directory and exercise the
 * same binary and stdio protocol boundary a new caller receives.
 *
 * This intentionally does not import workspace source or contact Discord. A
 * synthetic token is enough to prove packaging, CLI routing, offline doctor,
 * MCP initialization, progressive tools/list, and discovery behavior.
 */
import { strict as assert } from 'node:assert';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { request } from 'node:http';
import { createRequire } from 'node:module';
import { createConnection, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

const repoRoot = resolve(import.meta.dirname, '../..');
const tempPrefix = 'discord-mcp-package-acceptance-';
const tempRoot = mkdtempSync(join(tmpdir(), tempPrefix));
const packRoot = join(tempRoot, 'packs');
const installRoot = join(tempRoot, 'consumer');
const usesCommandShim = process.platform === 'win32';
const httpAccessToken = 'package-acceptance-access-token-at-least-32-chars';

mkdirSync(packRoot);
mkdirSync(installRoot);
writeFileSync(
  join(installRoot, 'package.json'),
  `${JSON.stringify({ name: 'discord-mcp-package-acceptance', private: true }, null, 2)}\n`,
);

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: 'utf8',
    timeout: 120_000,
    ...options,
  });
}

function packageManagerInvocation(name) {
  if (!usesCommandShim) return { command: name, args: [] };
  const pathDirectories = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
  const shim = pathDirectories
    .flatMap((directory) => [join(directory, `${name}.cmd`), join(directory, `${name}.exe`)])
    .find(existsSync);
  assert.ok(shim, `could not find ${name} on PATH`);
  const entry = join(
    dirname(shim),
    'node_modules',
    name,
    'bin',
    name === 'npm' ? 'npm-cli.js' : 'pnpm.cjs',
  );
  assert.ok(existsSync(entry), `could not find ${name} JavaScript entrypoint`);
  return { command: process.execPath, args: [entry] };
}

function runPackageManager(name, args, options = {}) {
  const invocation = packageManagerInvocation(name);
  return run(invocation.command, [...invocation.args, ...args], options);
}

function pack(packageDirectory, destination) {
  mkdirSync(destination);
  runPackageManager('pnpm', ['pack', '--pack-destination', destination], {
    cwd: packageDirectory,
  });
  const tarballs = readdirSync(destination).filter((entry) => entry.endsWith('.tgz'));
  assert.equal(tarballs.length, 1, `expected one tarball from ${packageDirectory}`);
  return join(destination, tarballs[0]);
}

function packageJson(directory) {
  return JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
}

function safeChildEnvironment(extra = {}) {
  const inheritedKeys = [
    'APPDATA',
    'COMSPEC',
    'LOCALAPPDATA',
    'PATH',
    'PATHEXT',
    'SYSTEMROOT',
    'TEMP',
    'TMP',
    'USERPROFILE',
    'WINDIR',
  ];
  const inherited = Object.fromEntries(
    inheritedKeys.flatMap((key) =>
      process.env[key] === undefined ? [] : [[key, process.env[key]]],
    ),
  );
  return { ...inherited, ...extra };
}

function removeOwnedTempDirectory(directory) {
  const resolvedBase = resolve(tmpdir());
  const resolvedDirectory = resolve(directory);
  const childPath = relative(resolvedBase, resolvedDirectory);
  assert.ok(
    childPath !== '' &&
      !childPath.startsWith('..') &&
      !isAbsolute(childPath) &&
      basename(resolvedDirectory).startsWith(tempPrefix),
    `refusing to remove unexpected path: ${resolvedDirectory}`,
  );
  rmSync(resolvedDirectory, { recursive: true, force: true });
}

async function reserveLoopbackPort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  assert.ok(address !== null && typeof address !== 'string', 'could not reserve a loopback port');
  await new Promise((resolveClose, reject) =>
    server.close((error) => (error ? reject(error) : resolveClose())),
  );
  return address.port;
}

async function waitForHttpReady(endpoint, child, stderr, timeoutMs = 30_000) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    assert.equal(
      child.exitCode,
      null,
      `packaged HTTP server exited before readiness: ${stderr().slice(0, 1_000)}`,
    );
    try {
      const response = await fetch(endpoint, { method: 'POST' });
      if (response.status === 401) return;
    } catch {
      // Listener startup races are expected while the child imports the package.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  assert.fail('packaged HTTP server did not become ready within 30 seconds');
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    once(child, 'exit'),
    new Promise((resolveWait) => setTimeout(resolveWait, 3_000)),
  ]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

async function postChunked(endpoint, body, headers = {}) {
  return new Promise((resolveResponse, reject) => {
    const req = request(
      endpoint,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${httpAccessToken}`,
          'Content-Type': 'application/json',
          'Transfer-Encoding': 'chunked',
          ...headers,
        },
      },
      (response) => {
        response.resume();
        response.once('end', () =>
          resolveResponse({
            status: response.statusCode ?? 0,
            retryAfter: response.headers['retry-after'],
          }),
        );
      },
    );
    req.once('error', reject);
    req.write(body);
    req.end();
  });
}

function percentile(samples, quantile) {
  const ordered = [...samples].sort((left, right) => left - right);
  return ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * quantile) - 1)];
}

try {
  const coreTarball = pack(join(repoRoot, 'packages/mcp-core'), join(packRoot, 'core'));
  const cliTarball = pack(join(repoRoot, 'packages/mcp-server'), join(packRoot, 'cli'));

  runPackageManager(
    'npm',
    [
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--package-lock=false',
      coreTarball,
      cliTarball,
    ],
    { cwd: installRoot },
  );

  const coreDirectory = join(installRoot, 'node_modules/@discord-mcp/core');
  const cliDirectory = join(installRoot, 'node_modules/@discord-mcp/cli');
  const cliEntry = join(cliDirectory, 'dist/cli.js');
  const cliBin = join(
    installRoot,
    'node_modules/.bin',
    usesCommandShim ? 'discord-mcp.cmd' : 'discord-mcp',
  );
  assert.ok(existsSync(cliEntry), 'packed CLI is missing dist/cli.js');
  assert.ok(existsSync(cliBin), 'packed CLI is missing the discord-mcp binary');

  const sourceCore = packageJson(join(repoRoot, 'packages/mcp-core'));
  const sourceCli = packageJson(join(repoRoot, 'packages/mcp-server'));
  const installedCore = packageJson(coreDirectory);
  const installedCli = packageJson(cliDirectory);
  assert.equal(installedCore.version, sourceCore.version);
  assert.equal(installedCli.version, sourceCli.version);

  const commonEnvironment = safeChildEnvironment({
    DISCORD_MCP_ACTIVITY: 'off',
    LOG_LEVEL: 'fatal',
    MCP_AUDIT_ENABLED: 'false',
    OTEL_ENABLED: 'false',
  });
  const cliCommand = usesCommandShim ? process.execPath : cliBin;
  const cliArguments = usesCommandShim ? [cliEntry] : [];
  const runCli = (args, options = {}) =>
    run(cliCommand, [...cliArguments, ...args], {
      cwd: installRoot,
      env: commonEnvironment,
      ...options,
    });
  const version = runCli(['--version']).trim();
  assert.equal(version, sourceCli.version);

  const help = runCli(['--help']);
  for (const command of ['serve', 'catalog', 'setup', 'doctor', 'init', 'smoke']) {
    assert.match(help, new RegExp(`\\b${command}\\b`));
  }

  const catalogCheckState = join(tempRoot, 'catalog-check-state');
  mkdirSync(catalogCheckState);
  const catalogCheck = JSON.parse(
    runCli(['catalog', '--check', '--json'], {
      env: safeChildEnvironment({
        APPDATA: catalogCheckState,
        XDG_CONFIG_HOME: catalogCheckState,
        DISCORD_TOKEN: 'ambient-token-that-must-not-be-read',
        GATEWAY: 'true',
        MCP_CATEGORIES: 'not-a-real-category',
        OTEL_ENABLED: 'true',
      }),
    }),
  );
  assert.equal(catalogCheck.ok, true);
  assert.deepEqual(catalogCheck.data, {
    schema_version: 'discord-mcp.catalog-check.v1',
    tool_count: 209,
    resource_count: 6,
    execution_guard: 'CATALOG_ONLY',
    credentials_required: false,
    discord_execution: 'disabled',
    activity_evidence_created: false,
  });
  assert.equal(
    existsSync(join(catalogCheckState, 'discord-mcp', 'activity.jsonl')),
    false,
    'packed catalog check must not create Activity Evidence or a local activity journal',
  );

  const initResult = JSON.parse(
    runCli([
      'init',
      '--client',
      'codex',
      '--tool-surface',
      'progressive',
      '--allowed-guilds',
      '123456789012345678',
      '--json',
    ]),
  );
  assert.equal(initResult.ok, true);
  assert.equal(initResult.data?.client, 'codex');
  assert.match(initResult.data?.content, /MCP_TOOL_SURFACE = "progressive"/);
  assert.match(initResult.data?.content, /ALLOWED_GUILDS = "123456789012345678"/);
  assert.doesNotMatch(initResult.data?.content, /Bot a{20}/);

  const serverEnvironment = safeChildEnvironment({
    ...commonEnvironment,
    DISCORD_TOKEN: `Bot ${'a'.repeat(60)}`,
    MCP_DRY_RUN: 'true',
    MCP_TOOL_SURFACE: 'progressive',
    MCP_WRITE_MODE: 'preview',
  });
  const doctor = JSON.parse(runCli(['doctor', '--json'], { env: serverEnvironment }));
  assert.equal(doctor.ok, true);
  assert.match(doctor.summary, /0 fail, 0 warn/);

  const requireFromCli = createRequire(join(cliDirectory, 'package.json'));
  const { Client, StreamableHTTPClientTransport } = requireFromCli('@modelcontextprotocol/client');
  const { StdioClientTransport } = requireFromCli('@modelcontextprotocol/client/stdio');
  const catalogTransport = new StdioClientTransport({
    command: process.execPath,
    args: [cliEntry, 'catalog'],
    cwd: installRoot,
    env: commonEnvironment,
    stderr: 'pipe',
  });
  const catalogClient = new Client(
    { name: 'discord-mcp-package-catalog-acceptance', version: '0.0.0' },
    { capabilities: {} },
  );

  try {
    await catalogClient.connect(catalogTransport);
    const { tools } = await catalogClient.listTools();
    assert.equal(tools.length, 209);
    for (const request of [
      { name: 'guild_get', arguments: { guild_id: '111122223333444455' } },
      {
        name: 'messages_send',
        arguments: { channel_id: '111122223333444455', content: 'must never execute' },
      },
      { name: 'unknown_catalog_tool', arguments: {} },
    ]) {
      const result = await catalogClient.callTool(request);
      assert.equal(result.isError, true);
      assert.equal(result.structuredContent?.code, 'CATALOG_ONLY');
      assert.equal(result.structuredContent?.retriable, false);
      assert.equal(result.structuredContent?.category, 'client');
    }
  } finally {
    await catalogClient.close();
  }

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cliEntry, 'serve'],
    cwd: installRoot,
    env: serverEnvironment,
    stderr: 'pipe',
  });
  const client = new Client(
    { name: 'discord-mcp-package-acceptance', version: '0.0.0' },
    { capabilities: {} },
  );

  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    const advertised = tools.map((tool) => tool.name);
    assert.deepEqual(advertised, [
      'build_discord_server',
      'guild_blueprint_apply',
      'guild_blueprint_evidence',
      'mcp_tools_search',
      'mcp_tools_read',
      'mcp_tools_write',
      'mcp_tools_destructive',
    ]);

    const exact = await client.callTool({
      name: 'mcp_tools_search',
      arguments: { query: 'channels_get', limit: 8 },
    });
    assert.equal(exact.isError, false);
    assert.equal(exact.structuredContent?.matches?.length, 1);
    assert.equal(exact.structuredContent?.matches?.[0]?.name, 'channels_get');
    assert.equal(exact.structuredContent?.matches?.[0]?.dispatcher, 'mcp_tools_read');

    const activityEvidence = await client.callTool({
      name: 'mcp_tools_search',
      arguments: { query: 'guild_blueprint_evidence', limit: 8 },
    });
    assert.equal(activityEvidence.isError, false);
    assert.equal(activityEvidence.structuredContent?.matches?.length, 1);
    assert.equal(
      activityEvidence.structuredContent?.matches?.[0]?.name,
      'guild_blueprint_evidence',
    );
    assert.equal(activityEvidence.structuredContent?.matches?.[0]?.dispatcher, 'mcp_tools_read');

    const naturalArchitect = await client.callTool({
      name: 'mcp_tools_search',
      arguments: { query: 'dựng cho tôi một server gaming chuyên nghiệp', limit: 1 },
    });
    assert.equal(naturalArchitect.isError, false);
    assert.equal(naturalArchitect.structuredContent?.matches?.length, 1);
    assert.equal(naturalArchitect.structuredContent?.matches?.[0]?.name, 'guild_blueprint_plan');
    assert.equal(naturalArchitect.structuredContent?.matches?.[0]?.dispatcher, 'mcp_tools_read');
    assert.deepEqual(naturalArchitect.structuredContent?.matches?.[0]?.inputSchema?.required, [
      'request',
    ]);

    const browse = await client.callTool({
      name: 'mcp_tools_search',
      arguments: { query: 'channels', limit: 8 },
    });
    assert.equal(browse.isError, false);
    assert.ok(browse.structuredContent?.matches?.length > 1);
  } finally {
    await client.close();
  }

  const httpPort = await reserveLoopbackPort();
  const httpEndpoint = new URL(`http://127.0.0.1:${httpPort}/mcp`);
  const httpEnvironment = {
    ...serverEnvironment,
    DISCORD_MCP_ACCESS_TOKEN: httpAccessToken,
    MCP_HTTP_MAX_BODY_BYTES: '1024',
    MCP_HTTP_MAX_IN_FLIGHT: '1',
  };
  const httpChild = spawn(
    process.execPath,
    [cliEntry, 'serve', '--http', '--host', '127.0.0.1', '--port', String(httpPort)],
    {
      cwd: installRoot,
      env: httpEnvironment,
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    },
  );
  let httpStderr = '';
  httpChild.stderr.on('data', (chunk) => {
    httpStderr += String(chunk);
  });
  let discoveryP50 = 0;
  let discoveryP95 = 0;

  try {
    await waitForHttpReady(httpEndpoint, httpChild, () => httpStderr);

    const wrongBearer = await fetch(httpEndpoint, {
      method: 'POST',
      headers: { Authorization: 'Bearer wrong-token' },
    });
    assert.equal(wrongBearer.status, 401);
    assert.equal(wrongBearer.headers.get('www-authenticate'), 'Bearer');

    const oversizedBody = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: {},
      padding: 'x'.repeat(2_048),
    });
    const oversized = await fetch(httpEndpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${httpAccessToken}`,
        'Content-Type': 'application/json',
        'Content-Length': String(Buffer.byteLength(oversizedBody)),
      },
      body: oversizedBody,
    });
    assert.equal(oversized.status, 413);

    const heldSocket = createConnection(httpPort, '127.0.0.1');
    await once(heldSocket, 'connect');
    heldSocket.write(
      [
        'POST /mcp HTTP/1.1',
        `Host: 127.0.0.1:${httpPort}`,
        `Authorization: Bearer ${httpAccessToken}`,
        'Content-Type: application/json',
        'Content-Length: 100',
        '',
        '{',
      ].join('\r\n'),
    );
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    try {
      const overloaded = await postChunked(
        httpEndpoint,
        JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
        { Accept: 'application/json, text/event-stream' },
      );
      assert.equal(overloaded.status, 503);
      assert.equal(overloaded.retryAfter, '1');
    } finally {
      heldSocket.destroy();
    }

    const httpTransport = new StreamableHTTPClientTransport(httpEndpoint, {
      requestInit: { headers: { Authorization: `Bearer ${httpAccessToken}` } },
    });
    const httpClient = new Client(
      { name: 'discord-mcp-package-http-acceptance', version: '0.0.0' },
      { versionNegotiation: { mode: 'auto' } },
    );

    try {
      await httpClient.connect(httpTransport);
      assert.equal(httpClient.getProtocolEra(), 'modern');
      assert.equal(httpTransport.sessionId, undefined);
      const { tools } = await httpClient.listTools();
      assert.deepEqual(
        tools.map((tool) => tool.name),
        [
          'build_discord_server',
          'guild_blueprint_apply',
          'guild_blueprint_evidence',
          'mcp_tools_search',
          'mcp_tools_read',
          'mcp_tools_write',
          'mcp_tools_destructive',
        ],
      );

      const discoverySamples = [];
      for (let index = 0; index < 20; index += 1) {
        const startedAt = performance.now();
        const discovery = await httpClient.callTool({
          name: 'mcp_tools_search',
          arguments: { query: index % 2 === 0 ? 'channels_get' : 'channels', limit: 8 },
        });
        discoverySamples.push(performance.now() - startedAt);
        assert.equal(discovery.isError, false);
      }
      discoveryP50 = percentile(discoverySamples, 0.5);
      discoveryP95 = percentile(discoverySamples, 0.95);

      const exactWrite = await httpClient.callTool({
        name: 'mcp_tools_search',
        arguments: { query: 'messages_send', limit: 1 },
      });
      assert.equal(exactWrite.structuredContent?.matches?.[0]?.dispatcher, 'mcp_tools_write');
      const preview = await httpClient.callTool({
        name: 'mcp_tools_write',
        arguments: {
          tool: 'messages_send',
          args: {
            channel_id: '111122223333444455',
            content: 'package acceptance must not reach Discord',
          },
        },
      });
      assert.equal(preview.isError, true);
      assert.equal(preview.structuredContent?.code, 'WRITE_PREVIEW');
    } finally {
      await httpClient.close();
    }

    assert.equal(httpStderr, '');
  } finally {
    await stopChild(httpChild);
  }

  process.stdout.write(
    `ok packaged @discord-mcp/core@${sourceCore.version} + ` +
      `@discord-mcp/cli@${sourceCli.version}; HTTP discovery ` +
      `p50=${discoveryP50.toFixed(2)}ms p95=${discoveryP95.toFixed(2)}ms\n`,
  );
} finally {
  removeOwnedTempDirectory(tempRoot);
}
