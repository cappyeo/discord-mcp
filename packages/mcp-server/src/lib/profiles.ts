import { randomUUID } from 'node:crypto';
import {
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';

const PROFILE_VERSION = 1;
const PROFILE_NAME = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;
const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/;
const SNOWFLAKE = /^\d{17,20}$/;
const CLIENT_IDS = [
  'claude-desktop',
  'claude-code',
  'codex',
  'antigravity-cli',
  'cursor-cli',
  'grok-cli',
  'gemini-cli',
  'cursor',
  'generic',
] as const;
const TOOL_SURFACES = ['full', 'progressive'] as const;
const WRITE_MODES = ['allow', 'preview'] as const;
const PROFILE_CATEGORY = /^[a-z][a-z0-9_]*$/;

export type ProfileClientId = (typeof CLIENT_IDS)[number];
export type ProfileToolSurface = (typeof TOOL_SURFACES)[number];
export type ProfileWriteMode = (typeof WRITE_MODES)[number];

export interface DiscordMcpProfile {
  readonly version: 1;
  readonly name: string;
  readonly bot: {
    readonly id: string;
    readonly username: string;
  };
  readonly credential: {
    readonly provider: 'env';
    readonly variable: 'DISCORD_TOKEN';
  };
  readonly allowedGuilds: readonly string[];
  readonly client: ProfileClientId;
  readonly toolSurface: ProfileToolSurface;
  readonly categories?: readonly string[] | null;
  readonly writeMode?: ProfileWriteMode;
  readonly gateway: boolean;
}

export interface ProfileLocationOptions {
  readonly directory?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly homeDirectory?: string;
  readonly platform?: NodeJS.Platform;
}

export interface SaveProfileOptions extends ProfileLocationOptions {
  readonly overwrite?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (
    actual.length !== sortedExpected.length ||
    actual.some((key, index) => key !== sortedExpected[index])
  ) {
    throw new Error(`${label} has unknown or missing fields`);
  }
}

export function normalizeProfileName(value: string): string {
  const name = value.trim();
  if (!PROFILE_NAME.test(name) || WINDOWS_DEVICE_NAME.test(name)) {
    throw new Error(
      'Profile name must start and end with a lowercase letter or digit, contain only lowercase letters, digits, dots, underscores, or hyphens, avoid Windows device names, and use at most 64 characters',
    );
  }
  return name;
}

export function normalizeProfileCategories(value: string | readonly string[]): string[] | null {
  const fromString = typeof value === 'string';
  const categories = fromString ? value.split(',').map((item) => item.trim()) : [...value];
  if (fromString && categories.length === 1 && categories[0] === '') return null;
  if (
    categories.length === 0 ||
    categories.some((category) => typeof category !== 'string' || !PROFILE_CATEGORY.test(category))
  ) {
    throw new Error(
      'Categories must be comma-separated lowercase names using letters, digits, and underscores',
    );
  }
  if (new Set(categories).size !== categories.length)
    throw new Error('Categories must not contain duplicates');
  return categories;
}

function parseProfileValue(value: unknown, expectedName?: string): DiscordMcpProfile {
  if (!isRecord(value)) throw new Error('Profile must be a JSON object');
  const baseKeys = [
    'version',
    'name',
    'bot',
    'credential',
    'allowedGuilds',
    'client',
    'toolSurface',
    'gateway',
  ];
  const hasPolicy = Object.keys(value).some((key) => key === 'categories' || key === 'writeMode');
  if (hasPolicy && (!Object.hasOwn(value, 'categories') || !Object.hasOwn(value, 'writeMode'))) {
    throw new Error('Profile policy requires both categories and writeMode');
  }
  assertExactKeys(
    value,
    hasPolicy ? [...baseKeys, 'categories', 'writeMode'] : baseKeys,
    'Profile',
  );

  if (value.version !== PROFILE_VERSION) {
    throw new Error(`Unsupported profile version: ${String(value.version)}`);
  }
  if (typeof value.name !== 'string') throw new Error('Profile name must be a string');
  const name = normalizeProfileName(value.name);
  if (expectedName !== undefined && name !== normalizeProfileName(expectedName)) {
    throw new Error(`Profile name mismatch: expected ${expectedName}, received ${name}`);
  }

  if (!isRecord(value.bot)) throw new Error('Profile bot must be an object');
  assertExactKeys(value.bot, ['id', 'username'], 'Profile bot');
  if (typeof value.bot.id !== 'string' || !SNOWFLAKE.test(value.bot.id)) {
    throw new Error('Profile bot id must be a 17-20 digit Discord snowflake');
  }
  if (
    typeof value.bot.username !== 'string' ||
    value.bot.username.length === 0 ||
    value.bot.username.length > 100
  ) {
    throw new Error('Profile bot username must contain 1-100 characters');
  }

  if (!isRecord(value.credential)) throw new Error('Profile credential must be an object');
  assertExactKeys(value.credential, ['provider', 'variable'], 'Profile credential');
  if (value.credential.provider !== 'env' || value.credential.variable !== 'DISCORD_TOKEN') {
    throw new Error('Profile credential must use env:DISCORD_TOKEN');
  }

  if (
    !Array.isArray(value.allowedGuilds) ||
    value.allowedGuilds.length === 0 ||
    value.allowedGuilds.some((id) => typeof id !== 'string' || !SNOWFLAKE.test(id))
  ) {
    throw new Error('Profile allowedGuilds must contain Discord snowflake IDs');
  }
  const allowedGuilds = value.allowedGuilds as string[];
  if (new Set(allowedGuilds).size !== allowedGuilds.length) {
    throw new Error('Profile allowedGuilds must not contain duplicates');
  }

  if (typeof value.client !== 'string' || !CLIENT_IDS.includes(value.client as ProfileClientId)) {
    throw new Error(`Profile client must be one of: ${CLIENT_IDS.join(', ')}`);
  }
  if (
    typeof value.toolSurface !== 'string' ||
    !TOOL_SURFACES.includes(value.toolSurface as ProfileToolSurface)
  ) {
    throw new Error(`Profile toolSurface must be one of: ${TOOL_SURFACES.join(', ')}`);
  }
  const categories = hasPolicy
    ? value.categories === null
      ? null
      : (() => {
          if (!Array.isArray(value.categories))
            throw new Error('Profile categories must be an array or null');
          return normalizeProfileCategories(value.categories);
        })()
    : null;
  const writeMode = hasPolicy ? value.writeMode : 'allow';
  if (typeof writeMode !== 'string' || !WRITE_MODES.includes(writeMode as ProfileWriteMode)) {
    throw new Error(`Profile writeMode must be one of: ${WRITE_MODES.join(', ')}`);
  }
  if (typeof value.gateway !== 'boolean') throw new Error('Profile gateway must be a boolean');

  return {
    version: PROFILE_VERSION,
    name,
    bot: { id: value.bot.id, username: value.bot.username },
    credential: { provider: 'env', variable: 'DISCORD_TOKEN' },
    allowedGuilds: [...allowedGuilds],
    client: value.client as ProfileClientId,
    toolSurface: value.toolSurface as ProfileToolSurface,
    categories,
    writeMode: writeMode as ProfileWriteMode,
    gateway: value.gateway,
  };
}

export function resolveProfileDirectory(options: ProfileLocationOptions = {}): string {
  if (options.directory !== undefined) return resolve(options.directory);

  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const homeDirectory = options.homeDirectory ?? homedir();
  let configRoot: string;
  if (platform === 'win32') {
    configRoot = env.APPDATA?.trim() || join(homeDirectory, 'AppData', 'Roaming');
  } else if (platform === 'darwin') {
    configRoot = join(homeDirectory, 'Library', 'Application Support');
  } else {
    const xdg = env.XDG_CONFIG_HOME?.trim();
    configRoot = xdg !== undefined && isAbsolute(xdg) ? xdg : join(homeDirectory, '.config');
  }
  return resolve(configRoot, 'discord-mcp', 'profiles');
}

export function profilePath(name: string, options: ProfileLocationOptions = {}): string {
  return join(resolveProfileDirectory(options), `${normalizeProfileName(name)}.json`);
}

export function profileExists(name: string, options: ProfileLocationOptions = {}): boolean {
  return existsSync(profilePath(name, options));
}

export function loadProfile(name: string, options: ProfileLocationOptions = {}): DiscordMcpProfile {
  const normalizedName = normalizeProfileName(name);
  const path = profilePath(normalizedName, options);
  if (!existsSync(path)) throw new Error(`Profile not found: ${normalizedName}`);

  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(
      `Cannot read profile ${normalizedName}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return parseProfileValue(value, normalizedName);
}

export function listProfiles(options: ProfileLocationOptions = {}): DiscordMcpProfile[] {
  const directory = resolveProfileDirectory(options);
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => loadProfile(basename(entry.name, '.json'), options))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function saveProfile(profile: DiscordMcpProfile, options: SaveProfileOptions = {}): string {
  const validated = parseProfileValue(profile);
  const target = profilePath(validated.name, options);
  const targetExisted = existsSync(target);
  if (targetExisted) {
    const current = loadProfile(validated.name, options);
    if (options.overwrite !== true) {
      throw new Error(`Profile ${validated.name} already exists; use --force to update it`);
    }
    if (current.bot.id !== validated.bot.id) {
      throw new Error(
        `Profile ${validated.name} is locked to bot ${current.bot.id}; remove it before assigning a different bot`,
      );
    }
  }

  const directory = resolveProfileDirectory(options);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `.${validated.name}.${process.pid}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, `${JSON.stringify(validated, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    if (targetExisted) {
      renameSync(temporary, target);
    } else {
      try {
        linkSync(temporary, target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          throw new Error(
            `Profile ${validated.name} was created by another process; inspect it before updating`,
          );
        }
        throw error;
      }
    }
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
  return target;
}

export function removeProfile(name: string, options: ProfileLocationOptions = {}): string {
  const normalizedName = normalizeProfileName(name);
  const target = profilePath(normalizedName, options);
  if (!existsSync(target)) throw new Error(`Profile not found: ${normalizedName}`);
  unlinkSync(target);
  return target;
}

export function activateProfile(
  name: string,
  options: ProfileLocationOptions & { readonly targetEnv?: NodeJS.ProcessEnv } = {},
): DiscordMcpProfile {
  const profile = loadProfile(name, options);
  const targetEnv = options.targetEnv ?? process.env;
  const token = targetEnv[profile.credential.variable];
  if (token === undefined || token === '') {
    throw new Error(
      `Profile ${profile.name} requires ${profile.credential.variable} in the launch environment`,
    );
  }

  targetEnv.DISCORD_EXPECTED_BOT_ID = profile.bot.id;
  targetEnv.ALLOWED_GUILDS = profile.allowedGuilds.join(',');
  targetEnv.MCP_TOOL_SURFACE = profile.toolSurface;
  if (profile.categories === undefined || profile.categories === null)
    delete targetEnv.MCP_CATEGORIES;
  else targetEnv.MCP_CATEGORIES = profile.categories.join(',');
  targetEnv.MCP_WRITE_MODE = profile.writeMode ?? 'allow';
  if (profile.gateway) {
    targetEnv.GATEWAY = '1';
  } else {
    delete targetEnv.GATEWAY;
  }
  return profile;
}
