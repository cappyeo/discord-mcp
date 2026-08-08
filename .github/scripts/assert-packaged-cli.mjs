/**
 * Install the publishable tarballs into an empty directory and exercise the
 * same binary and stdio protocol boundary a new caller receives.
 *
 * This intentionally does not import workspace source or contact Discord. A
 * synthetic token is enough to prove packaging, CLI routing, offline doctor,
 * MCP initialization, progressive tools/list, and discovery behavior.
 */
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path';

const repoRoot = resolve(import.meta.dirname, '../..');
const tempPrefix = 'discord-mcp-package-acceptance-';
const tempRoot = mkdtempSync(join(tmpdir(), tempPrefix));
const packRoot = join(tempRoot, 'packs');
const installRoot = join(tempRoot, 'consumer');
const usesCommandShim = process.platform === 'win32';

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
  for (const command of ['serve', 'setup', 'doctor', 'init', 'smoke']) {
    assert.match(help, new RegExp(`\\b${command}\\b`));
  }

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
  const { Client } = requireFromCli('@modelcontextprotocol/client');
  const { StdioClientTransport } = requireFromCli('@modelcontextprotocol/client/stdio');
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

    const browse = await client.callTool({
      name: 'mcp_tools_search',
      arguments: { query: 'channels', limit: 8 },
    });
    assert.equal(browse.isError, false);
    assert.ok(browse.structuredContent?.matches?.length > 1);
  } finally {
    await client.close();
  }

  process.stdout.write(
    `ok packaged @discord-mcp/core@${sourceCore.version} + @discord-mcp/cli@${sourceCli.version}\n`,
  );
} finally {
  removeOwnedTempDirectory(tempRoot);
}
