import { randomUUID } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  renameSync,
  type Stats,
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
const MAX_PROFILE_BYTES = 1024 * 1024;

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

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

function sameFileIdentity(expected: Stats, actual: Stats): boolean {
  if (expected.ino !== actual.ino || expected.ino === 0) return false;
  if (expected.dev === actual.dev) return true;
  return process.platform === 'win32' && (expected.dev === 0 || actual.dev === 0);
}

// The directory path is caller-owned. Resolve its selected ancestor chain once,
// but reject a final symlink/junction so each operation uses a stable directory.
function canonicalProfileDirectory(directory: string): string | undefined {
  let metadata: Stats;
  try {
    metadata = lstatSync(directory);
  } catch (error) {
    if (missing(error)) return undefined;
    throw error;
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error('Profile directory must be a regular directory');
  }
  return realpathSync(directory);
}

function ensureProfileDirectory(directory: string): string {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const canonical = canonicalProfileDirectory(directory);
  if (canonical === undefined) throw new Error('Profile directory disappeared while opening');
  return canonical;
}

function inspectProfileFile(path: string): Stats | undefined {
  let metadata: Stats;
  try {
    metadata = lstatSync(path);
  } catch (error) {
    if (missing(error)) return undefined;
    throw error;
  }
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size > MAX_PROFILE_BYTES) {
    throw new Error('Profile must be a bounded regular file');
  }
  return metadata;
}

function readDescriptorBounded(descriptor: number): string {
  const chunks: Buffer[] = [];
  let total = 0;
  while (total <= MAX_PROFILE_BYTES) {
    const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, MAX_PROFILE_BYTES + 1 - total));
    const bytesRead = readSync(descriptor, chunk, 0, chunk.length, null);
    if (bytesRead === 0) break;
    chunks.push(chunk.subarray(0, bytesRead));
    total += bytesRead;
  }
  if (total > MAX_PROFILE_BYTES) throw new Error('Profile must be a bounded regular file');
  return Buffer.concat(chunks, total).toString('utf8');
}

interface StoredProfile {
  readonly text: string;
  readonly identity: Stats;
}

function readStoredProfile(path: string): StoredProfile | undefined {
  const expected = inspectProfileFile(path);
  if (expected === undefined) return undefined;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const actual = fstatSync(descriptor);
    if (
      !actual.isFile() ||
      actual.size > MAX_PROFILE_BYTES ||
      !sameFileIdentity(expected, actual)
    ) {
      throw new Error('Profile changed while opening');
    }
    return { text: readDescriptorBounded(descriptor), identity: actual };
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function parseStoredProfile(stored: StoredProfile, normalizedName: string): DiscordMcpProfile {
  let value: unknown;
  try {
    value = JSON.parse(stored.text);
  } catch (error) {
    throw new Error(
      `Cannot read profile ${normalizedName}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return parseProfileValue(value, normalizedName);
}

function storedProfilePath(directory: string, normalizedName: string): string {
  return join(directory, `${normalizedName}.json`);
}

export function profileExists(name: string, options: ProfileLocationOptions = {}): boolean {
  const normalizedName = normalizeProfileName(name);
  const directory = canonicalProfileDirectory(resolveProfileDirectory(options));
  return (
    directory !== undefined &&
    inspectProfileFile(storedProfilePath(directory, normalizedName)) !== undefined
  );
}

export function loadProfile(name: string, options: ProfileLocationOptions = {}): DiscordMcpProfile {
  const normalizedName = normalizeProfileName(name);
  let stored: StoredProfile | undefined;
  try {
    const directory = canonicalProfileDirectory(resolveProfileDirectory(options));
    stored =
      directory === undefined
        ? undefined
        : readStoredProfile(storedProfilePath(directory, normalizedName));
  } catch (error) {
    throw new Error(
      `Cannot read profile ${normalizedName}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (stored === undefined) throw new Error(`Profile not found: ${normalizedName}`);
  return parseStoredProfile(stored, normalizedName);
}

export function listProfiles(options: ProfileLocationOptions = {}): DiscordMcpProfile[] {
  const directory = canonicalProfileDirectory(resolveProfileDirectory(options));
  if (directory === undefined) return [];
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => {
      const normalizedName = normalizeProfileName(basename(entry.name, '.json'));
      const stored = readStoredProfile(storedProfilePath(directory, normalizedName));
      if (stored === undefined) throw new Error(`Profile not found: ${normalizedName}`);
      return parseStoredProfile(stored, normalizedName);
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function saveProfile(profile: DiscordMcpProfile, options: SaveProfileOptions = {}): string {
  const validated = parseProfileValue(profile);
  const requestedTarget = profilePath(validated.name, options);
  const directory = ensureProfileDirectory(resolveProfileDirectory(options));
  const target = storedProfilePath(directory, validated.name);
  const existing = readStoredProfile(target);
  if (existing !== undefined) {
    const current = parseStoredProfile(existing, validated.name);
    if (options.overwrite !== true) {
      throw new Error(`Profile ${validated.name} already exists; use --force to update it`);
    }
    if (current.bot.id !== validated.bot.id) {
      throw new Error(
        `Profile ${validated.name} is locked to bot ${current.bot.id}; remove it before assigning a different bot`,
      );
    }
  }

  const content = `${JSON.stringify(validated, null, 2)}\n`;
  if (Buffer.byteLength(content, 'utf8') > MAX_PROFILE_BYTES) {
    throw new Error('Profile must be a bounded regular file');
  }
  const temporary = join(directory, `.${validated.name}.${process.pid}.${randomUUID()}.tmp`);
  let descriptor: number | undefined;
  let temporaryIdentity: Stats | undefined;
  try {
    descriptor = openSync(
      temporary,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        (fsConstants.O_NOFOLLOW ?? 0),
      0o600,
    );
    temporaryIdentity = fstatSync(descriptor);
    if (!temporaryIdentity.isFile()) throw new Error('Profile temporary file is unsafe');
    writeFileSync(descriptor, content, { encoding: 'utf8' });
    fsyncSync(descriptor);
    const written = fstatSync(descriptor);
    if (
      !written.isFile() ||
      written.size > MAX_PROFILE_BYTES ||
      !sameFileIdentity(temporaryIdentity, written)
    ) {
      throw new Error('Profile temporary file is unsafe');
    }
    closeSync(descriptor);
    descriptor = undefined;

    const prepared = inspectProfileFile(temporary);
    if (prepared === undefined || !sameFileIdentity(temporaryIdentity, prepared)) {
      throw new Error('Profile temporary file changed before publishing');
    }
    if (existing !== undefined) {
      const current = inspectProfileFile(target);
      if (current === undefined || !sameFileIdentity(existing.identity, current)) {
        throw new Error(
          `Profile ${validated.name} changed while updating; inspect it before retrying`,
        );
      }
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
      const published = inspectProfileFile(target);
      if (published === undefined || !sameFileIdentity(temporaryIdentity, published)) {
        throw new Error(`Profile ${validated.name} changed while publishing`);
      }
    }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (temporaryIdentity !== undefined) {
      try {
        const current = lstatSync(temporary);
        if (
          !current.isSymbolicLink() &&
          current.isFile() &&
          sameFileIdentity(temporaryIdentity, current)
        ) {
          unlinkSync(temporary);
        }
      } catch (error) {
        if (!missing(error)) {
          // Best-effort cleanup must not replace the profile operation result.
        }
      }
    }
  }
  return requestedTarget;
}

export function removeProfile(name: string, options: ProfileLocationOptions = {}): string {
  const normalizedName = normalizeProfileName(name);
  const requestedTarget = profilePath(normalizedName, options);
  const directory = canonicalProfileDirectory(resolveProfileDirectory(options));
  if (directory === undefined) throw new Error(`Profile not found: ${normalizedName}`);
  const target = storedProfilePath(directory, normalizedName);
  const expected = inspectProfileFile(target);
  if (expected === undefined) throw new Error(`Profile not found: ${normalizedName}`);
  const current = inspectProfileFile(target);
  if (current === undefined || !sameFileIdentity(expected, current)) {
    throw new Error(`Profile ${normalizedName} changed while removing; inspect it before retrying`);
  }
  unlinkSync(target);
  return requestedTarget;
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
