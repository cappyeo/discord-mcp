import { execFile as nodeExecFile } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { runBoundedHostProcess } from './bounded-host-process.mjs';

export const CURSOR_CLI_DRIVER_SCHEMA = 'discord-mcp.cursor-cli-driver.v1';
export const CURSOR_CLI_MCP_SERVER = 'discord-mcp';
export const CURSOR_CLI_TOOLS = Object.freeze([
  'build_discord_server',
  'guild_blueprint_apply',
  'guild_blueprint_evidence',
]);

const execFile = promisify(nodeExecFile);
const PROXY_PATH = fileURLToPath(new URL('./mcp-capture-proxy.mjs', import.meta.url));
const SNOWFLAKE = /^\d{17,20}$/u;
const SAFE_ENV_KEYS = Object.freeze([
  'PATH',
  'SystemRoot',
  'ComSpec',
  'TEMP',
  'TMP',
  'LANG',
  'LC_ALL',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'CURSOR_API_KEY',
]);
const DEFAULT_TIMEOUT_MS = 175_000;

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requiredString(value, name) {
  if (typeof value !== 'string' || value.trim() === '' || /[\r\n]/u.test(value))
    throw new TypeError(`${name} is required and must not contain newlines`);
  return value;
}

function absolutePath(value, name) {
  requiredString(value, name);
  if (!isAbsolute(value)) throw new TypeError(`${name} must be absolute`);
  return resolve(value);
}

function targetIds(target) {
  if (!record(target)) throw new TypeError('target is required');
  const guildId = target.guildId ?? target.guild_id;
  const botId = target.botId ?? target.bot_id;
  if (typeof guildId !== 'string' || !SNOWFLAKE.test(guildId))
    throw new TypeError('target.guildId must be a Discord snowflake');
  if (typeof botId !== 'string' || !SNOWFLAKE.test(botId))
    throw new TypeError('target.botId must be a Discord snowflake');
  return { guildId, botId };
}

function writeMode(value) {
  if (value !== 'preview' && value !== 'allow')
    throw new TypeError('mode must be preview or allow');
  return value;
}

async function regularFile(path, name, { executable = false, platform = process.platform } = {}) {
  const canonical = resolve(await realpath(absolutePath(path, name)));
  const metadata = await lstat(canonical);
  if (!metadata.isFile()) throw new Error(`${name} must be a regular file`);
  if (executable && platform !== 'win32' && (metadata.mode & 0o111) === 0)
    throw new Error(`${name} must be executable`);
  return canonical;
}

async function ensureDirectory(path, name, platform = process.platform) {
  const canonical = resolve(await realpath(absolutePath(path, name)));
  const metadata = await lstat(canonical);
  if (metadata.isSymbolicLink() || !metadata.isDirectory())
    throw new Error(`${name} must be a regular directory`);
  if (platform !== 'win32') await chmod(canonical, 0o700);
  return canonical;
}

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function buildCursorCliEnvironment({
  sourceEnv = process.env,
  discordToken,
  privateHome,
} = {}) {
  if (!record(sourceEnv)) throw new TypeError('sourceEnv is required');
  const home = absolutePath(privateHome, 'privateHome');
  const environment = {};
  for (const key of SAFE_ENV_KEYS) {
    if (typeof sourceEnv[key] === 'string' && sourceEnv[key] !== '')
      environment[key] = sourceEnv[key];
  }
  environment.DISCORD_TOKEN = requiredString(discordToken, 'DISCORD_TOKEN');
  environment.HOME = home;
  environment.USERPROFILE = home;
  return environment;
}

export function buildCursorCliPermissions() {
  return {
    permissions: {
      allow: CURSOR_CLI_TOOLS.map((tool) => `Mcp(${CURSOR_CLI_MCP_SERVER}:${tool})`),
      deny: ['Shell(*)', 'Read(**)', 'Write(**)'],
    },
  };
}

export function buildCursorCliMcpConfig({
  nodePath = process.execPath,
  cliPath,
  proxyPath = PROXY_PATH,
  capturePath,
  target,
  stateDirectory,
  mode = 'allow',
} = {}) {
  const node = absolutePath(nodePath, 'nodePath');
  const cli = absolutePath(cliPath, 'cliPath');
  const proxy = absolutePath(proxyPath, 'proxyPath');
  const capture = absolutePath(capturePath, 'capturePath');
  const state = absolutePath(stateDirectory, 'stateDirectory');
  const ids = targetIds(target);
  const selectedMode = writeMode(mode);
  return {
    mcpServers: {
      [CURSOR_CLI_MCP_SERVER]: {
        command: node,
        args: [
          proxy,
          '--capture',
          capture,
          '--strip-env',
          'CURSOR_API_KEY',
          '--',
          node,
          cli,
          'serve',
        ],
        env: {
          DISCORD_EXPECTED_BOT_ID: ids.botId,
          DISCORD_DEFAULT_GUILD_ID: ids.guildId,
          ALLOWED_GUILDS: ids.guildId,
          MCP_TOOL_SURFACE: 'progressive',
          MCP_AUDIT_ENABLED: 'true',
          MCP_AUDIT_SINK: 'file',
          MCP_AUDIT_FILE: join(state, 'audit.jsonl'),
          MCP_BLUEPRINT_STATE_DIR: state,
          MCP_WRITE_MODE: selectedMode,
          MCP_DRY_RUN: selectedMode === 'preview' ? 'true' : 'false',
        },
      },
    },
  };
}

export function validateCursorCliMcpConfig(config, options = {}) {
  const expected = buildCursorCliMcpConfig(options);
  if (!record(config) || JSON.stringify(config) !== JSON.stringify(expected))
    throw new Error('Cursor Agent MCP config does not match the exact target-bound contract');
  const serialized = JSON.stringify(config);
  if (/DISCORD_TOKEN/iu.test(serialized))
    throw new Error('Cursor Agent MCP config must not persist the Discord token');
  if (options.cursorApiKey && serialized.includes(options.cursorApiKey))
    throw new Error('Cursor Agent MCP config must not persist the Cursor API key');
  return true;
}

async function candidate(path, platform) {
  try {
    return await regularFile(path, 'Cursor Agent launcher', { executable: true, platform });
  } catch {
    return null;
  }
}

/** Resolve only the unambiguous Cursor-owned alias. Native Windows must use WSL. */
export async function resolveCursorCliLauncher({
  platform = process.platform,
  command = 'cursor-agent',
  run = execFile,
} = {}) {
  if (platform === 'win32')
    throw new Error('Cursor Agent CLI requires WSL on Windows; refusing a native shell fallback');
  if (command === 'agent')
    throw new Error('Cursor Agent launcher must use the unambiguous cursor-agent alias');
  const selected = isAbsolute(command)
    ? command
    : String((await run('which', [command], { encoding: 'utf8' })).stdout ?? '')
        .split(/\r?\n/u)
        .find(Boolean)
        ?.trim();
  const path = selected === undefined ? null : await candidate(selected, platform);
  if (path === null) throw new Error('Cursor Agent CLI launcher is unavailable');
  return { command: path, prefix_args: [], kind: 'native' };
}

export function runBoundedCursorCliProcess(options = {}) {
  return runBoundedHostProcess({
    timeoutMs: DEFAULT_TIMEOUT_MS,
    processDidNotCloseCode: 'CURSOR_CLI_PROCESS_DID_NOT_CLOSE',
    ...options,
  });
}

async function removeWithRetry(path) {
  let lastError;
  for (const delay of [0, 20, 50, 100]) {
    if (delay > 0) await new Promise((resolveWait) => setTimeout(resolveWait, delay));
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      if (!['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(error?.code)) throw error;
    }
  }
  throw lastError;
}

/** Create an isolated Cursor workspace, exact permissions, MCP proxy, and capture state. */
export async function prepareCursorCliPrivateState({
  target,
  cliPath,
  nodePath = process.execPath,
  proxyPath = PROXY_PATH,
  discordToken,
  stateDirectory,
  mode = 'allow',
  sourceEnv = process.env,
  baseDirectory = tmpdir(),
  platform = process.platform,
} = {}) {
  requiredString(discordToken, 'DISCORD_TOKEN');
  const base = await ensureDirectory(baseDirectory, 'baseDirectory', platform);
  const root = resolve(await mkdtemp(join(base, 'discord-mcp-cursor-cli-')));
  if (platform !== 'win32') await chmod(root, 0o700);
  try {
    const node = await regularFile(nodePath, 'nodePath', { executable: true, platform });
    const cli = await regularFile(cliPath, 'cliPath', { platform });
    const proxy = await regularFile(proxyPath, 'proxyPath', { platform });
    const state = await ensureDirectory(stateDirectory, 'stateDirectory', platform);
    if (state === root || state.startsWith(`${root}${sep}`))
      throw new Error('stateDirectory must be distinct from private Cursor state');

    const cursorDirectory = join(root, '.cursor');
    await mkdir(cursorDirectory, { recursive: false, mode: 0o700 });
    const capturePath = join(root, 'mcp-capture.jsonl');
    const mcpConfigPath = join(cursorDirectory, 'mcp.json');
    const settingsPath = join(cursorDirectory, 'cli.json');
    await writeFile(capturePath, '', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    const config = buildCursorCliMcpConfig({
      nodePath: node,
      cliPath: cli,
      proxyPath: proxy,
      capturePath,
      target,
      stateDirectory: state,
      mode,
    });
    validateCursorCliMcpConfig(config, {
      nodePath: node,
      cliPath: cli,
      proxyPath: proxy,
      capturePath,
      target,
      stateDirectory: state,
      mode,
      cursorApiKey: sourceEnv.CURSOR_API_KEY,
    });
    const settings = buildCursorCliPermissions();
    await Promise.all([
      writeFile(mcpConfigPath, json(config), { encoding: 'utf8', mode: 0o600, flag: 'wx' }),
      writeFile(settingsPath, json(settings), { encoding: 'utf8', mode: 0o600, flag: 'wx' }),
    ]);
    const serialized = `${await readFile(mcpConfigPath, 'utf8')}\n${await readFile(
      settingsPath,
      'utf8',
    )}`;
    if (serialized.includes(discordToken))
      throw new Error('private Cursor config contains the Discord credential');
    if (sourceEnv.CURSOR_API_KEY && serialized.includes(sourceEnv.CURSOR_API_KEY))
      throw new Error('private Cursor config contains the Cursor credential');

    let cleaned = false;
    return {
      schema_version: CURSOR_CLI_DRIVER_SCHEMA,
      path: root,
      workspacePath: root,
      mcpConfigPath,
      settingsPath,
      capturePath,
      captureCursor: 0,
      config,
      settings,
      environment: buildCursorCliEnvironment({
        sourceEnv,
        discordToken,
        privateHome: root,
      }),
      async cleanup() {
        if (cleaned) return;
        cleaned = true;
        await removeWithRetry(root);
      },
    };
  } catch (error) {
    await removeWithRetry(root).catch(() => {});
    throw error;
  }
}
