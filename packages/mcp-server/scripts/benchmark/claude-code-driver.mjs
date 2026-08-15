import { execFile as nodeExecFile, spawn as nodeSpawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, extname, isAbsolute, join, parse, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

export const CLAUDE_CODE_DRIVER_SCHEMA = 'discord-mcp.claude-code-driver.v1';
export const CLAUDE_CODE_MCP_SERVER = 'discord-mcp';
// biome-ignore lint/suspicious/noTemplateCurlyInString: literal placeholder is part of Claude's env interpolation contract
export const CLAUDE_CODE_TOKEN_PLACEHOLDER = '${DISCORD_TOKEN}';
export const CLAUDE_CODE_TOOL_SURFACE = 'progressive';

const execFile = promisify(nodeExecFile);
const SNOWFLAKE = /^\d{17,20}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const API_KEY_MAX_BYTES = 4096;
const BROKER_REQUEST_MAX_BYTES = 256;
const BROKER_RESPONSE_MAX_BYTES = API_KEY_MAX_BYTES + 1;
const DEFAULT_BROKER_CALLS = 16;
const DEFAULT_BROKER_TIMEOUT_MS = 2_000;
const SAFE_ENV_KEYS = Object.freeze([
  'PATH',
  'HOME',
  'USERPROFILE',
  'SystemRoot',
  'ComSpec',
  'TEMP',
  'TMP',
  'LANG',
  'LC_ALL',
]);
const CLAUDE_CODE_MAX_STDOUT_BYTES = 8 * 1024 * 1024;
const CLAUDE_CODE_DEFAULT_TIMEOUT_MS = 175_000;
const CLAUDE_CODE_TERMINATION_GRACE_MS = 2_000;

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requiredString(value, name, { newlineFree = false } = {}) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${name} is required`);
  if (newlineFree && /[\r\n]/u.test(value))
    throw new TypeError(`${name} must not contain newlines`);
  return value;
}

function absolutePath(value, name) {
  requiredString(value, name);
  if (!isAbsolute(value)) throw new TypeError(`${name} must be absolute`);
  return value;
}

function snowflake(value, name) {
  requiredString(value, name);
  if (!SNOWFLAKE.test(value)) throw new TypeError(`${name} must be a Discord snowflake`);
  return value;
}

function targetIds(target) {
  if (!record(target)) throw new TypeError('target is required');
  return {
    guildId: snowflake(target.guildId ?? target.guild_id, 'target.guildId'),
    botId: snowflake(target.botId ?? target.bot_id, 'target.botId'),
  };
}

function mode(value) {
  if (value !== 'preview' && value !== 'allow')
    throw new TypeError('mode must be preview or allow');
  return value;
}

function hash(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function safeApiKey(value) {
  requiredString(value, 'ANTHROPIC_API_KEY', { newlineFree: true });
  if (Buffer.byteLength(value, 'utf8') > API_KEY_MAX_BYTES)
    throw new TypeError('ANTHROPIC_API_KEY is too large');
  return value;
}

function jsonText(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function assertNoSecretText(value, label) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (text.includes('ANTHROPIC_API_KEY') || text.includes('anthropic_api_key'))
    throw new Error(`${label} contains a forbidden Anthropic secret reference`);
  // biome-ignore lint/suspicious/noTemplateCurlyInString: literal legacy placeholder must be rejected
  if (text.includes('${env:DISCORD_TOKEN}'))
    throw new Error(`${label} contains the legacy Discord token placeholder`);
}

function quotePosix(value) {
  requiredString(value, 'shell argument', { newlineFree: true });
  return `'${value.replaceAll("'", "'\\\"'\\\"'")}'`;
}

export function quoteClaudeCodeShellArg(value, platform = process.platform) {
  void platform;
  return quotePosix(value);
}

function gitBashPath(value, platform) {
  if (platform !== 'win32') return value;
  if (value.includes('pipe')) return value.replaceAll('\\', '/');
  const match = /^([A-Za-z]):[\\/](.*)$/u.exec(value);
  if (!match) return value;
  return `/${match[1].toLowerCase()}/${match[2].replaceAll('\\', '/')}`;
}

export function buildClaudeCodeApiKeyHelperCommand({
  nodePath = process.execPath,
  driverPath = fileURLToPath(import.meta.url),
  endpoint,
  nonce,
  platform = process.platform,
} = {}) {
  absolutePath(nodePath, 'nodePath');
  absolutePath(driverPath, 'driverPath');
  requiredString(endpoint, 'auth endpoint', { newlineFree: true });
  requiredString(nonce, 'auth nonce', { newlineFree: true });
  return [
    gitBashPath(nodePath, platform),
    gitBashPath(driverPath, platform),
    '--api-key-helper',
    '--endpoint',
    gitBashPath(endpoint, platform),
    '--nonce',
    nonce,
  ]
    .map((part) => quoteClaudeCodeShellArg(part, platform))
    .join(' ');
}

function endpointFor(platform) {
  const suffix = randomBytes(20).toString('hex');
  return platform === 'win32'
    ? `\\\\.\\pipe\\discord-mcp-claude-${suffix}`
    : join(tmpdir(), `.discord-mcp-claude-${suffix}.sock`);
}

async function listen(server, endpoint) {
  server.listen(endpoint);
  await Promise.race([
    once(server, 'listening'),
    once(server, 'error').then(([error]) => {
      throw error;
    }),
  ]);
}

async function ensurePrivateDirectory(path, name, platform, { privateDirectory = true } = {}) {
  const requested = resolve(absolutePath(path, name));
  const missing = [];
  let current = requested;
  while (true) {
    try {
      const metadata = await lstat(current);
      if (metadata.isSymbolicLink()) throw new Error(`${name} must not contain a symlink`);
      if (!metadata.isDirectory()) throw new Error(`${name} must contain directories only`);
      break;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      missing.push(current);
      const parent = dirname(current);
      if (parent === current) throw new Error(`${name} has no existing directory ancestor`);
      current = parent;
    }
  }
  current = resolve(current);
  while (true) {
    const metadata = await lstat(current);
    if (metadata.isSymbolicLink()) throw new Error(`${name} must not contain a symlink`);
    if (!metadata.isDirectory()) throw new Error(`${name} must contain directories only`);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  for (const component of missing.reverse()) {
    try {
      await mkdir(component, { recursive: false, mode: 0o700 });
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
    const metadata = await lstat(component);
    if (metadata.isSymbolicLink() || !metadata.isDirectory())
      throw new Error(`${name} changed while creating its path`);
    if (platform !== 'win32') await chmod(component, 0o700);
  }
  const canonical = resolve(await realpath(requested));
  const metadata = await lstat(canonical);
  if (metadata.isSymbolicLink() || !metadata.isDirectory())
    throw new Error(`${name} must be a regular directory`);
  if (privateDirectory && platform !== 'win32') {
    await chmod(canonical, 0o700);
    const privateMetadata = await lstat(canonical);
    if ((privateMetadata.mode & 0o077) !== 0) throw new Error(`${name} is not private`);
  }
  return canonical;
}

function boundedSocket(socket, { maxBytes, timeoutMs, onMessage }) {
  let total = 0;
  let settled = false;
  const chunks = [];
  const finish = (value) => {
    if (settled) return;
    settled = true;
    onMessage(value);
  };
  socket.setTimeout(timeoutMs, () => {
    socket.destroy();
    finish(null);
  });
  socket.on('data', (chunk) => {
    if (settled) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.byteLength;
    if (total > maxBytes) {
      socket.destroy();
      finish(null);
      return;
    }
    chunks.push(bytes);
    if (Buffer.concat(chunks).includes(10)) {
      finish(Buffer.concat(chunks).toString('utf8').split('\n', 1)[0]);
    }
  });
  socket.once('end', () => finish(Buffer.concat(chunks).toString('utf8').split('\n', 1)[0]));
  socket.once('error', () => finish(null));
}

/** Create a bounded in-memory API-key broker for Claude's apiKeyHelper. */
export async function createClaudeCodeAuthBroker({
  apiKey = process.env.ANTHROPIC_API_KEY,
  platform = process.platform,
  endpoint = endpointFor(platform),
  maxCalls = DEFAULT_BROKER_CALLS,
  timeoutMs = DEFAULT_BROKER_TIMEOUT_MS,
  server = net.createServer(),
  afterListen = null,
} = {}) {
  const key = Buffer.from(safeApiKey(apiKey), 'utf8');
  const nonce = randomBytes(32).toString('hex');
  if (!Number.isSafeInteger(maxCalls) || maxCalls < 1 || maxCalls > 32)
    throw new TypeError('maxCalls must be between 1 and 32');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > 30_000)
    throw new TypeError('timeoutMs is invalid');
  let calls = 0;
  let closed = false;
  const sockets = new Set();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    boundedSocket(socket, {
      maxBytes: BROKER_REQUEST_MAX_BYTES,
      timeoutMs,
      onMessage: (message) => {
        if (closed || message !== nonce || calls >= maxCalls) {
          socket.end('DENIED\n');
          return;
        }
        calls += 1;
        socket.end(Buffer.concat([key, Buffer.from('\n')]));
      },
    });
  });
  let cleanupPromise;
  const cleanup = async () => {
    if (cleanupPromise) return cleanupPromise;
    cleanupPromise = (async () => {
      closed = true;
      let firstError = null;
      for (const socket of sockets) {
        try {
          socket.destroy();
        } catch (error) {
          firstError ??= error;
        }
      }
      try {
        if (server.listening) {
          await new Promise((resolveClose, rejectClose) =>
            server.close((error) => (error ? rejectClose(error) : resolveClose())),
          );
        }
      } catch (error) {
        firstError ??= error;
      }
      try {
        if (platform !== 'win32') await rm(endpoint, { force: true });
      } catch (error) {
        firstError ??= error;
      }
      try {
        key.fill(0);
      } catch (error) {
        firstError ??= error;
      }
      if (firstError !== null) throw firstError;
    })();
    return cleanupPromise;
  };
  try {
    await listen(server, endpoint);
    if (afterListen !== null) await afterListen({ endpoint, platform });
    else if (platform !== 'win32') await chmod(endpoint, 0o600);
  } catch (error) {
    try {
      await cleanup();
    } catch {
      // Preserve the post-listen/setup failure while cleanup still runs fully.
    }
    throw error;
  }
  return {
    endpoint,
    nonce,
    get calls() {
      return calls;
    },
    cleanup,
  };
}

export async function requestClaudeCodeApiKey({
  endpoint,
  nonce,
  timeoutMs = DEFAULT_BROKER_TIMEOUT_MS,
  connect = net.createConnection,
} = {}) {
  requiredString(endpoint, 'auth endpoint', { newlineFree: true });
  requiredString(nonce, 'auth nonce', { newlineFree: true });
  return new Promise((resolveKey, rejectKey) => {
    const socket = connect(endpoint);
    const chunks = [];
    let bytes = 0;
    let settled = false;
    const finish = (error, value = null) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) rejectKey(error);
      else resolveKey(value);
    };
    const timer = setTimeout(() => finish(new Error('AUTH_BROKER_TIMEOUT')), timeoutMs);
    socket.on('connect', () => socket.write(`${nonce}\n`));
    socket.on('data', (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.byteLength;
      if (bytes > BROKER_RESPONSE_MAX_BYTES) {
        clearTimeout(timer);
        finish(new Error('AUTH_BROKER_RESPONSE_TOO_LARGE'));
        return;
      }
      chunks.push(buffer);
    });
    socket.once('error', () => {
      clearTimeout(timer);
      finish(new Error('AUTH_BROKER_UNAVAILABLE'));
    });
    socket.once('close', () => {
      clearTimeout(timer);
      const value = Buffer.concat(chunks)
        .toString('utf8')
        .replace(/\r?\n$/u, '');
      if (!value || value === 'DENIED' || /[\r\n]/u.test(value)) {
        finish(new Error('AUTH_BROKER_DENIED'));
        return;
      }
      finish(null, value);
    });
  });
}

function parseHelperArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === '--endpoint' || key === '--nonce') values.set(key, argv[++index]);
  }
  return { endpoint: values.get('--endpoint'), nonce: values.get('--nonce') };
}

export async function runClaudeCodeApiKeyHelper({ endpoint, nonce } = {}) {
  const value = await requestClaudeCodeApiKey({ endpoint, nonce });
  process.stdout.write(value);
  return value;
}

function validateEnvValue(value, name) {
  requiredString(value, name, { newlineFree: true });
  return value;
}

export function buildClaudeCodeEnvironment({
  sourceEnv = process.env,
  discordToken,
  claudeConfigDir,
} = {}) {
  if (!record(sourceEnv)) throw new TypeError('sourceEnv is required');
  const environment = {};
  for (const key of SAFE_ENV_KEYS) {
    if (typeof sourceEnv[key] === 'string' && sourceEnv[key] !== '')
      environment[key] = sourceEnv[key];
  }
  environment.DISCORD_TOKEN = validateEnvValue(discordToken, 'DISCORD_TOKEN');
  environment.CLAUDE_CONFIG_DIR = absolutePath(claudeConfigDir, 'CLAUDE_CONFIG_DIR');
  for (const key of Object.keys(environment)) {
    if (key.startsWith('ANTHROPIC_'))
      throw new Error('Claude environment contains a forbidden secret');
  }
  return environment;
}

export function buildClaudeCodeMcpConfig({
  nodePath = process.execPath,
  cliPath,
  target,
  stateDirectory,
  mode: writeMode = 'preview',
  toolSurface = CLAUDE_CODE_TOOL_SURFACE,
  audit = true,
} = {}) {
  const node = absolutePath(nodePath, 'nodePath');
  const cli = absolutePath(cliPath, 'cliPath');
  const ids = targetIds(target);
  const state = absolutePath(stateDirectory, 'stateDirectory');
  if (toolSurface !== 'progressive') throw new TypeError('toolSurface must be progressive');
  if (audit !== true) throw new TypeError('audit must be true');
  const writeModeValue = mode(writeMode);
  return {
    mcpServers: {
      [CLAUDE_CODE_MCP_SERVER]: {
        command: node,
        args: [cli, 'serve'],
        env: {
          DISCORD_TOKEN: CLAUDE_CODE_TOKEN_PLACEHOLDER,
          DISCORD_EXPECTED_BOT_ID: ids.botId,
          DISCORD_DEFAULT_GUILD_ID: ids.guildId,
          ALLOWED_GUILDS: ids.guildId,
          MCP_TOOL_SURFACE: toolSurface,
          MCP_AUDIT_ENABLED: 'true',
          MCP_AUDIT_SINK: 'file',
          MCP_AUDIT_FILE: join(state, 'audit.jsonl'),
          MCP_BLUEPRINT_STATE_DIR: state,
          MCP_WRITE_MODE: writeModeValue,
          MCP_DRY_RUN: writeModeValue === 'preview' ? 'true' : 'false',
        },
      },
    },
  };
}

export function validateClaudeCodeMcpConfig(
  config,
  {
    nodePath = process.execPath,
    cliPath,
    target,
    stateDirectory,
    mode: writeMode = 'preview',
  } = {},
) {
  if (!record(config) || Object.keys(config).length !== 1 || !record(config.mcpServers))
    throw new TypeError('Claude MCP config must contain only mcpServers');
  if (
    Object.keys(config.mcpServers).length !== 1 ||
    !record(config.mcpServers[CLAUDE_CODE_MCP_SERVER])
  )
    throw new Error('Claude MCP config must contain exactly one discord-mcp server');
  const server = config.mcpServers[CLAUDE_CODE_MCP_SERVER];
  const expected = buildClaudeCodeMcpConfig({
    nodePath,
    cliPath,
    target,
    stateDirectory,
    mode: writeMode,
  });
  if (JSON.stringify(server) !== JSON.stringify(expected.mcpServers[CLAUDE_CODE_MCP_SERVER]))
    throw new Error('Claude MCP config does not match the exact target-bound contract');
  assertNoSecretText(config, 'Claude MCP config');
  if (!JSON.stringify(config).includes(CLAUDE_CODE_TOKEN_PLACEHOLDER))
    throw new Error('Claude MCP config is missing the Discord token placeholder');
  return true;
}

async function verifyRegularFile(
  path,
  name,
  { requireExecutable = false, platform = process.platform } = {},
) {
  const absolute = absolutePath(path, name);
  const canonical = resolve(await realpath(absolute));
  const metadata = await lstat(canonical);
  if (!metadata.isFile()) throw new Error(`${name} must be a regular file`);
  if (requireExecutable && platform !== 'win32' && (metadata.mode & 0o111) === 0)
    throw new Error(`${name} must be executable`);
  return canonical;
}

export async function verifyClaudeCodeRuntimePaths({
  nodePath = process.execPath,
  cliPath,
  cliDigest = null,
  platform = process.platform,
} = {}) {
  const node = await verifyRegularFile(nodePath, 'nodePath', {
    requireExecutable: true,
    platform,
  });
  const cli = await verifyRegularFile(cliPath, 'cliPath', { platform });
  if (cliDigest !== null) {
    if (!DIGEST.test(cliDigest)) throw new TypeError('cliDigest is invalid');
    const bytes = await readFile(cli);
    if (hash(bytes) !== cliDigest) throw new Error('cliPath digest mismatch');
  }
  return { nodePath: node, cliPath: cli };
}

async function candidateFile(
  path,
  { requireExecutable = false, platform = process.platform } = {},
) {
  try {
    return await verifyRegularFile(path, 'Claude launcher', {
      requireExecutable,
      platform,
    });
  } catch {
    return null;
  }
}

export async function resolveClaudeCodeLauncher({
  platform = process.platform,
  command = 'claude',
  run = execFile,
} = {}) {
  if (platform !== 'win32') {
    const candidate = isAbsolute(command)
      ? command
      : String((await run('which', [command], { encoding: 'utf8' })).stdout ?? '')
          .split(/\r?\n/u)
          .find(Boolean)
          ?.trim();
    const path =
      candidate === undefined
        ? null
        : await candidateFile(candidate, { requireExecutable: true, platform });
    if (path === null) throw new Error('Claude Code native launcher is unavailable');
    return { command: path, prefix_args: [], kind: 'native' };
  }

  const candidates = [];
  if (isAbsolute(command)) candidates.push(command);
  else {
    const result = await run('where.exe', [command], { encoding: 'utf8', windowsHide: true });
    candidates.push(
      ...String(result.stdout ?? '')
        .split(/\r?\n/u)
        .map((item) => item.trim())
        .filter(Boolean),
    );
  }
  for (const candidate of candidates) {
    const extension = extname(candidate).toLowerCase();
    if (extension === '.exe') {
      const path = await candidateFile(candidate, { platform });
      if (path !== null) return { command: path, prefix_args: [], kind: 'native' };
      continue;
    }
    if (extension === '.cmd' || extension === '.ps1') {
      const parsed = parse(candidate);
      const sibling = await candidateFile(
        join(parsed.dir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'),
        { platform },
      );
      if (sibling !== null) return { command: sibling, prefix_args: [], kind: 'native-sibling' };
    }
  }
  throw new Error('Claude Code shim is unresolved; refusing shell fallback');
}

/** Run one bounded Claude Code invocation with a close proof for cleanup safety. */
export async function runBoundedClaudeCodeProcess({
  launcher,
  args,
  cwd,
  env,
  timeoutMs = CLAUDE_CODE_DEFAULT_TIMEOUT_MS,
  platform = process.platform,
  spawn = nodeSpawn,
  terminate = null,
  signal: abortSignal,
} = {}) {
  if (!record(launcher) || typeof launcher.command !== 'string')
    throw new TypeError('launcher is required');
  if (!Array.isArray(args) || typeof cwd !== 'string' || !record(env))
    throw new TypeError('Claude Code process arguments are invalid');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)
    throw new TypeError('timeoutMs must be positive');
  if (abortSignal !== undefined && !(abortSignal instanceof AbortSignal))
    throw new TypeError('signal must be an AbortSignal');
  if (abortSignal?.aborted === true)
    return {
      stdout: '',
      exitCode: null,
      signal: null,
      timedOut: false,
      aborted: true,
      spawnError: false,
      truncated: false,
    };
  const invocation = [
    ...(Array.isArray(launcher.prefix_args) ? launcher.prefix_args : []),
    ...args,
  ];
  return new Promise((resolveResult, rejectResult) => {
    const chunks = [];
    let bytes = 0;
    let child;
    let timer;
    let stopPromise;
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let spawnError = false;
    let truncated = false;
    let closeResolve;
    const closed = new Promise((resolveClose) => {
      closeResolve = resolveClose;
    });
    const finish = (exitCode, closeSignal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      abortSignal?.removeEventListener('abort', onAbort);
      resolveResult({
        stdout: Buffer.concat(chunks).toString('utf8'),
        exitCode,
        signal: closeSignal,
        timedOut,
        aborted,
        spawnError,
        truncated,
      });
    };
    const terminateTree = async (force) => {
      if (!child?.pid) return;
      if (terminate !== null) {
        try {
          await terminate({ child, platform, force });
        } catch {
          // The close proof below remains authoritative.
        }
        return;
      }
      try {
        if (platform === 'win32') {
          await execFile('taskkill', ['/PID', String(child.pid), '/T', ...(force ? ['/F'] : [])], {
            windowsHide: true,
          });
        } else {
          process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM');
        }
      } catch {
        // The close proof below remains authoritative.
      }
    };
    const waitForClose = () =>
      Promise.race([
        closed.then(() => true),
        new Promise((resolveClose) =>
          setTimeout(() => resolveClose(false), CLAUDE_CODE_TERMINATION_GRACE_MS),
        ),
      ]);
    const stop = (kind) => {
      if (stopPromise !== undefined) return stopPromise;
      stopPromise = (async () => {
        if (kind === 'timeout') timedOut = true;
        if (kind === 'abort') aborted = true;
        await terminateTree(false);
        if (await waitForClose()) return;
        await terminateTree(true);
        if (!(await waitForClose()) && !settled) {
          settled = true;
          clearTimeout(timer);
          abortSignal?.removeEventListener('abort', onAbort);
          const error = new Error('CLAUDE_CODE_PROCESS_DID_NOT_CLOSE');
          error.code = 'CLAUDE_CODE_PROCESS_DID_NOT_CLOSE';
          rejectResult(error);
        }
      })();
      return stopPromise;
    };
    const onAbort = () => void stop('abort');
    try {
      child = spawn(launcher.command, invocation, {
        cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: platform !== 'win32',
        windowsHide: true,
      });
    } catch {
      spawnError = true;
      finish(null, null);
      return;
    }
    child.stdout?.on('data', (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      if (bytes >= CLAUDE_CODE_MAX_STDOUT_BYTES) {
        truncated = true;
        return;
      }
      const remaining = CLAUDE_CODE_MAX_STDOUT_BYTES - bytes;
      const bounded = buffer.byteLength > remaining ? buffer.subarray(0, remaining) : buffer;
      chunks.push(bounded);
      bytes += bounded.byteLength;
      if (bounded.byteLength < buffer.byteLength) truncated = true;
    });
    child.stderr?.on('data', () => {});
    child.once('error', () => {
      spawnError = true;
      if (timedOut || aborted) return;
      if (!child.pid) {
        finish(null, null);
        return;
      }
      void stop('error');
    });
    child.once('close', (code, closeSignal) => {
      closeResolve();
      finish(code, closeSignal);
    });
    timer = setTimeout(() => void stop('timeout'), timeoutMs);
    abortSignal?.addEventListener('abort', onAbort, { once: true });
    if (abortSignal?.aborted === true) onAbort();
  });
}

export async function resolveClaudeCodeShell({ platform = process.platform, run = execFile } = {}) {
  if (platform !== 'win32') {
    const path = await candidateFile('/bin/sh', { requireExecutable: true, platform });
    if (path === null) throw new Error('POSIX shell is unavailable; refusing apiKeyHelper');
    return { command: path, kind: 'posix-shell' };
  }
  const candidates = [
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
  ];
  try {
    const result = await run('where.exe', ['bash.exe'], { encoding: 'utf8', windowsHide: true });
    candidates.push(
      ...String(result.stdout ?? '')
        .split(/\r?\n/u)
        .map((item) => item.trim())
        .filter(Boolean),
    );
  } catch {
    // The fixed Git Bash locations remain eligible below.
  }
  for (const candidate of candidates) {
    const path = await candidateFile(candidate, { platform });
    if (path !== null) return { command: path, kind: 'git-bash' };
  }
  throw new Error('Git Bash is unavailable; refusing apiKeyHelper');
}

export async function prepareClaudeCodePrivateState({
  target,
  cliPath,
  nodePath = process.execPath,
  discordToken,
  stateDirectory,
  apiKey = process.env.ANTHROPIC_API_KEY,
  mode: writeMode = 'preview',
  sourceEnv = process.env,
  baseDirectory = tmpdir(),
  driverPath = fileURLToPath(import.meta.url),
  platform = process.platform,
  createBroker = createClaudeCodeAuthBroker,
} = {}) {
  const rootBase = await ensurePrivateDirectory(baseDirectory, 'baseDirectory', platform, {
    privateDirectory: false,
  });
  const root = resolve(await mkdtemp(join(rootBase, 'discord-mcp-claude-')));
  await chmod(root, 0o700);
  let broker;
  try {
    const paths = await verifyClaudeCodeRuntimePaths({ nodePath, cliPath, platform });
    const shell = await resolveClaudeCodeShell({ platform });
    const durableState = await ensurePrivateDirectory(stateDirectory, 'stateDirectory', platform);
    if (
      resolve(durableState) === resolve(root) ||
      resolve(durableState).startsWith(`${resolve(root)}${sep}`)
    )
      throw new Error('stateDirectory must be distinct from private Claude state');
    broker = await createBroker({ apiKey, platform });
    const settingsPath = join(root, 'settings.json');
    const mcpConfigPath = join(root, 'mcp.json');
    const settings = {
      apiKeyHelper: buildClaudeCodeApiKeyHelperCommand({
        nodePath: paths.nodePath,
        driverPath,
        endpoint: broker.endpoint,
        nonce: broker.nonce,
        platform,
      }),
    };
    const config = buildClaudeCodeMcpConfig({
      nodePath: paths.nodePath,
      cliPath: paths.cliPath,
      target,
      stateDirectory: durableState,
      mode: writeMode,
    });
    validateClaudeCodeMcpConfig(config, {
      nodePath: paths.nodePath,
      cliPath: paths.cliPath,
      target,
      stateDirectory: durableState,
      mode: writeMode,
    });
    await writeFile(settingsPath, jsonText(settings), { encoding: 'utf8', mode: 0o600 });
    await writeFile(mcpConfigPath, jsonText(config), { encoding: 'utf8', mode: 0o600 });
    await chmod(settingsPath, 0o600);
    await chmod(mcpConfigPath, 0o600);
    const childEnvironment = buildClaudeCodeEnvironment({
      sourceEnv,
      discordToken,
      claudeConfigDir: root,
    });
    return {
      schema_version: CLAUDE_CODE_DRIVER_SCHEMA,
      root,
      path: root,
      settingsPath,
      mcpConfigPath,
      config,
      settings,
      environment: childEnvironment,
      launcherPaths: paths,
      shell,
      broker,
      configDigest: hash(jsonText(config)),
      async cleanup() {
        let firstError = null;
        try {
          await broker.cleanup();
        } catch (error) {
          firstError = error;
        }
        try {
          await rm(root, { recursive: true, force: true });
        } catch (error) {
          firstError ??= error;
        }
        if (firstError !== null) throw firstError;
      },
    };
  } catch (error) {
    let firstError = error;
    try {
      await broker?.cleanup();
    } catch (cleanupError) {
      firstError ??= cleanupError;
    }
    try {
      await rm(root, { recursive: true, force: true });
    } catch (cleanupError) {
      firstError ??= cleanupError;
    }
    throw firstError;
  }
}

if (process.argv.includes('--api-key-helper')) {
  const { endpoint, nonce } = parseHelperArgs(process.argv.slice(2));
  try {
    await runClaudeCodeApiKeyHelper({ endpoint, nonce });
  } catch {
    process.exitCode = 1;
  }
}
