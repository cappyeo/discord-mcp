import { execFile as nodeExecFile } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { runBoundedHostProcess } from './bounded-host-process.mjs';

export const GROK_CLI_DRIVER_SCHEMA = 'discord-mcp.grok-cli-driver.v1';
export const GROK_CLI_MCP_SERVER = 'discord-mcp';
export const GROK_CLI_TOOLS = Object.freeze([
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
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'XAI_API_KEY',
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

function tomlString(value) {
  return JSON.stringify(value);
}

function renderTomlArray(values) {
  return `[${values.map(tomlString).join(', ')}]`;
}

export function renderGrokCliMcpConfig(config) {
  const server = config?.mcp_servers?.[GROK_CLI_MCP_SERVER];
  if (!record(server) || !record(server.env)) throw new TypeError('Grok CLI MCP config is invalid');
  const lines = [
    `[mcp_servers.${GROK_CLI_MCP_SERVER}]`,
    `command = ${tomlString(server.command)}`,
    `args = ${renderTomlArray(server.args)}`,
    `enabled = ${String(server.enabled)}`,
    `startup_timeout_sec = ${String(server.startup_timeout_sec)}`,
    `tool_timeout_sec = ${String(server.tool_timeout_sec)}`,
    '',
    `[mcp_servers.${GROK_CLI_MCP_SERVER}.env]`,
  ];
  for (const [name, value] of Object.entries(server.env))
    lines.push(`${name} = ${tomlString(value)}`);
  return `${lines.join('\n')}\n`;
}

export function buildGrokCliEnvironment({
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
  environment.GROK_HOME = home;
  environment.HOME = home;
  environment.USERPROFILE = home;
  return environment;
}

export function buildGrokCliMcpConfig({
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
    mcp_servers: {
      [GROK_CLI_MCP_SERVER]: {
        command: node,
        args: [
          proxy,
          '--capture',
          capture,
          '--strip-env',
          'XAI_API_KEY',
          '--strip-env',
          'GROK_API_KEY',
          '--strip-env',
          'GROK_CODE_XAI_API_KEY',
          '--',
          node,
          cli,
          'serve',
        ],
        enabled: true,
        startup_timeout_sec: 90,
        tool_timeout_sec: 180,
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

export function validateGrokCliMcpConfig(config, options = {}) {
  const expected = buildGrokCliMcpConfig(options);
  if (!record(config) || JSON.stringify(config) !== JSON.stringify(expected))
    throw new Error('Grok CLI MCP config does not match the exact target-bound contract');
  const serialized = renderGrokCliMcpConfig(config);
  const token = options.discordToken;
  if (typeof token === 'string' && serialized.includes(token))
    throw new Error('Grok CLI MCP config must not persist the Discord credential');
  return true;
}

async function candidate(path, platform) {
  try {
    return await regularFile(path, 'Grok CLI launcher', { executable: true, platform });
  } catch {
    return null;
  }
}

/** Resolve only the official Grok Build executable. */
export async function resolveGrokCliLauncher({
  platform = process.platform,
  command = 'grok',
  run = execFile,
} = {}) {
  const selected = isAbsolute(command)
    ? command
    : String(
        (await run(platform === 'win32' ? 'where.exe' : 'which', [command], { encoding: 'utf8' }))
          .stdout ?? '',
      )
        .split(/\r?\n/u)
        .find(Boolean)
        ?.trim();
  const path = selected === undefined ? null : await candidate(selected, platform);
  if (path === null) throw new Error('Grok Build CLI launcher is unavailable');
  return { command: path, prefix_args: [], kind: 'native' };
}

export function runBoundedGrokCliProcess(options = {}) {
  return runBoundedHostProcess({
    timeoutMs: DEFAULT_TIMEOUT_MS,
    processDidNotCloseCode: 'GROK_CLI_PROCESS_DID_NOT_CLOSE',
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

/** Create an isolated GROK_HOME, target-bound MCP config, and private capture state. */
export async function prepareGrokCliPrivateState({
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
  const root = resolve(await mkdtemp(join(base, 'discord-mcp-grok-cli-')));
  if (platform !== 'win32') await chmod(root, 0o700);
  try {
    const node = await regularFile(nodePath, 'nodePath', { executable: true, platform });
    const cli = await regularFile(cliPath, 'cliPath', { platform });
    const proxy = await regularFile(proxyPath, 'proxyPath', { platform });
    const state = await ensureDirectory(stateDirectory, 'stateDirectory', platform);
    if (state === root || state.startsWith(`${root}${sep}`))
      throw new Error('stateDirectory must be distinct from private Grok state');
    const workspacePath = join(root, 'workspace');
    await mkdir(workspacePath, { mode: 0o700 });
    const capturePath = join(root, 'mcp-capture.jsonl');
    const settingsPath = join(root, 'config.toml');
    await writeFile(capturePath, '', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    const config = buildGrokCliMcpConfig({
      nodePath: node,
      cliPath: cli,
      proxyPath: proxy,
      capturePath,
      target,
      stateDirectory: state,
      mode,
    });
    validateGrokCliMcpConfig(config, {
      nodePath: node,
      cliPath: cli,
      proxyPath: proxy,
      capturePath,
      target,
      stateDirectory: state,
      mode,
      discordToken,
    });
    await writeFile(settingsPath, renderGrokCliMcpConfig(config), {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    const serialized = await readFile(settingsPath, 'utf8');
    if (serialized.includes(discordToken))
      throw new Error('private Grok settings contain the Discord credential');
    let cleaned = false;
    return {
      schema_version: GROK_CLI_DRIVER_SCHEMA,
      path: root,
      workspacePath,
      settingsPath,
      mcpConfigPath: settingsPath,
      capturePath,
      captureCursor: 0,
      config,
      environment: buildGrokCliEnvironment({ sourceEnv, discordToken, privateHome: root }),
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
