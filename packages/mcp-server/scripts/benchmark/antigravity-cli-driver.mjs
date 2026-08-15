import { execFile as nodeExecFile } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { runBoundedHostProcess } from './bounded-host-process.mjs';

export const ANTIGRAVITY_CLI_DRIVER_SCHEMA = 'discord-mcp.antigravity-cli-driver.v1';
export const ANTIGRAVITY_CLI_MCP_SERVER = 'discord-mcp';
export const ANTIGRAVITY_CLI_TOOLS = Object.freeze([
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
  'GEMINI_API_KEY',
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

export function buildAntigravityEnvironment({
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

export function buildAntigravityPermissions() {
  return {
    permissions: {
      allow: ANTIGRAVITY_CLI_TOOLS.map((tool) => `mcp(${ANTIGRAVITY_CLI_MCP_SERVER}/${tool})`),
      deny: [
        'command(*)',
        'unsandboxed(*)',
        'read_file(*)',
        'write_file(*)',
        'read_url(*)',
        'execute_url(*)',
      ],
      ask: [],
    },
  };
}

export function buildAntigravityMcpConfig({
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
      [ANTIGRAVITY_CLI_MCP_SERVER]: {
        command: node,
        args: [
          proxy,
          '--capture',
          capture,
          '--strip-env',
          'GEMINI_API_KEY',
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

export function validateAntigravityMcpConfig(config, options = {}) {
  const expected = buildAntigravityMcpConfig(options);
  if (!record(config) || JSON.stringify(config) !== JSON.stringify(expected))
    throw new Error('Antigravity MCP config does not match the exact target-bound contract');
  if (/DISCORD_TOKEN/iu.test(JSON.stringify(config)))
    throw new Error('Antigravity MCP config must not persist the Discord token');
  return true;
}

async function candidate(path, options) {
  try {
    return await regularFile(path, 'Antigravity launcher', options);
  } catch {
    return null;
  }
}

export async function resolveAntigravityLauncher({
  platform = process.platform,
  command = 'agy',
  run = execFile,
} = {}) {
  if (platform !== 'win32') {
    const selected = isAbsolute(command)
      ? command
      : String((await run('which', [command], { encoding: 'utf8' })).stdout ?? '')
          .split(/\r?\n/u)
          .find(Boolean)
          ?.trim();
    const path =
      selected === undefined ? null : await candidate(selected, { executable: true, platform });
    if (path === null) throw new Error('Antigravity CLI launcher is unavailable');
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
  for (const path of candidates) {
    if (extname(path).toLowerCase() !== '.exe') continue;
    const selected = await candidate(path, { platform });
    if (selected !== null) return { command: selected, prefix_args: [], kind: 'native' };
  }
  throw new Error('Antigravity CLI launcher is unavailable; refusing shell fallback');
}

export function runBoundedAntigravityProcess(options = {}) {
  return runBoundedHostProcess({
    timeoutMs: DEFAULT_TIMEOUT_MS,
    processDidNotCloseCode: 'ANTIGRAVITY_CLI_PROCESS_DID_NOT_CLOSE',
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

/** Create isolated Antigravity settings, exact permissions, MCP proxy, and private capture state. */
export async function prepareAntigravityPrivateState({
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
  const root = resolve(await mkdtemp(join(base, 'discord-mcp-antigravity-')));
  if (platform !== 'win32') await chmod(root, 0o700);
  try {
    const node = await regularFile(nodePath, 'nodePath', { executable: true, platform });
    const cli = await regularFile(cliPath, 'cliPath', { platform });
    const proxy = await regularFile(proxyPath, 'proxyPath', { platform });
    const state = await ensureDirectory(stateDirectory, 'stateDirectory', platform);
    if (state === root || state.startsWith(`${root}${sep}`))
      throw new Error('stateDirectory must be distinct from private Antigravity state');

    const configDirectory = join(root, '.gemini', 'config');
    const settingsDirectory = join(root, '.gemini', 'antigravity-cli');
    await mkdir(configDirectory, { recursive: true, mode: 0o700 });
    await mkdir(settingsDirectory, { recursive: true, mode: 0o700 });
    const capturePath = join(root, 'mcp-capture.jsonl');
    const mcpConfigPath = join(configDirectory, 'mcp_config.json');
    const settingsPath = join(settingsDirectory, 'settings.json');
    await writeFile(capturePath, '', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    const config = buildAntigravityMcpConfig({
      nodePath: node,
      cliPath: cli,
      proxyPath: proxy,
      capturePath,
      target,
      stateDirectory: state,
      mode,
    });
    validateAntigravityMcpConfig(config, {
      nodePath: node,
      cliPath: cli,
      proxyPath: proxy,
      capturePath,
      target,
      stateDirectory: state,
      mode,
    });
    const settings = buildAntigravityPermissions();
    await Promise.all([
      writeFile(mcpConfigPath, json(config), { encoding: 'utf8', mode: 0o600, flag: 'wx' }),
      writeFile(settingsPath, json(settings), { encoding: 'utf8', mode: 0o600, flag: 'wx' }),
    ]);
    const serialized = `${await readFile(mcpConfigPath, 'utf8')}\n${await readFile(
      settingsPath,
      'utf8',
    )}`;
    if (serialized.includes(discordToken) || /DISCORD_TOKEN/iu.test(serialized))
      throw new Error('private Antigravity config contains a Discord credential');

    let cleaned = false;
    return {
      schema_version: ANTIGRAVITY_CLI_DRIVER_SCHEMA,
      path: root,
      mcpConfigPath,
      settingsPath,
      capturePath,
      captureCursor: 0,
      config,
      settings,
      environment: buildAntigravityEnvironment({
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
