import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  fchmodSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  type Stats,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { emitResult } from '../lib/output.js';
import { type DiscordMcpProfile, loadProfile } from '../lib/profiles.js';

const PACKAGE_NAME = '@discord-mcp/cli';
const REGISTRY_URL = 'https://registry.npmjs.org/@discord-mcp%2fcli';
const RECOMMENDED_CODEX_TOOL_TIMEOUT_SEC = 180;
const MAX_CONFIG_BYTES = 1024 * 1024;
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export interface UpdateOptions {
  profile: string;
  apply?: boolean;
  check?: boolean;
  config?: string;
  json?: boolean;
  profileDirectory?: string;
  homeDirectory?: string;
  env?: NodeJS.ProcessEnv;
}

interface VersionParts {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease?: string;
}

export interface LauncherMatch {
  readonly configName: string;
  readonly sectionStart: number;
  readonly sectionEnd: number;
  readonly argsStart: number;
  readonly argsEnd: number;
  readonly currentVersion: string;
}

/**
 * Normalized, non-secret state from one generated Codex launcher. This is
 * intentionally safe to return from `doctor`: it does not contain config
 * text, environment values, token material, endpoints, or filesystem paths.
 */
export interface CodexClientConfigInspection {
  readonly configName: string;
  readonly currentVersion: string;
  readonly enabled: boolean;
  readonly startupTimeoutSec: number | null;
  readonly dryRun: boolean | null;
  readonly writeMode: 'allow' | 'preview' | null;
  readonly otelEnabled: boolean | null;
}

export type CodexLauncherUpdateErrorKind =
  | 'config-missing'
  | 'config-read'
  | 'launcher-unrecognized'
  | 'launcher-ambiguous'
  | 'registry-unavailable'
  | 'version-unsafe';

export class CodexLauncherUpdateError extends Error {
  constructor(
    readonly kind: CodexLauncherUpdateErrorKind,
    message: string,
  ) {
    super(message);
  }
}

export interface CodexLauncherUpdateInspection {
  readonly configPath: string;
  readonly config: string;
  readonly launcher: LauncherMatch;
  readonly currentVersion: string;
  readonly targetVersion: string;
  readonly updateAvailable: boolean;
}

interface ConfigLocation {
  readonly requestedPath: string;
  readonly storagePath: string;
  readonly directoryIdentity: Stats;
}

interface StoredConfig {
  readonly location: ConfigLocation;
  readonly config: string;
  readonly contentDigest: string;
  readonly identity: Stats;
}

interface ConfigStorage {
  readonly location: ConfigLocation;
  readonly fileIdentity: Stats;
  readonly contentDigest: string;
}

interface InternalCodexLauncherUpdateInspection extends CodexLauncherUpdateInspection {
  readonly storage: ConfigStorage;
}

function parseVersion(value: string): VersionParts | undefined {
  const match = SEMVER.exec(value);
  if (match === null) return undefined;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    ...(match[4] === undefined ? {} : { prerelease: match[4] }),
  };
}

function comparePrerelease(left: string | undefined, right: string | undefined): number {
  if (left === undefined) return right === undefined ? 0 : 1;
  if (right === undefined) return -1;

  const leftParts = left.split('.');
  const rightParts = right.split('.');
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const leftPart = leftParts[index];
    const rightPart = rightParts[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;

    const leftNumber = /^\d+$/.test(leftPart) ? Number(leftPart) : undefined;
    const rightNumber = /^\d+$/.test(rightPart) ? Number(rightPart) : undefined;
    if (leftNumber !== undefined && rightNumber !== undefined) return leftNumber - rightNumber;
    if (leftNumber !== undefined) return -1;
    if (rightNumber !== undefined) return 1;
    return leftPart.localeCompare(rightPart);
  }
  return 0;
}

function compareVersions(left: string, right: string): number | undefined {
  const leftParts = parseVersion(left);
  const rightParts = parseVersion(right);
  if (leftParts === undefined || rightParts === undefined) return undefined;
  for (const field of ['major', 'minor', 'patch'] as const) {
    if (leftParts[field] !== rightParts[field]) return leftParts[field] - rightParts[field];
  }
  return comparePrerelease(leftParts.prerelease, rightParts.prerelease);
}

function resolveCodexConfigPath(
  options: Pick<UpdateOptions, 'config' | 'homeDirectory' | 'env'>,
): string {
  if (options.config !== undefined) return resolve(options.config);
  const env = options.env ?? process.env;
  const root = env.CODEX_HOME?.trim() || join(options.homeDirectory ?? homedir(), '.codex');
  return join(root, 'config.toml');
}

async function latestPublishedVersion(): Promise<string> {
  let response: Response;
  try {
    response = await fetch(REGISTRY_URL, {
      headers: { accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(5_000),
    });
  } catch (error) {
    throw new Error(
      `could not reach the npm registry: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!response.ok) throw new Error(`npm registry returned HTTP ${response.status}`);

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error('npm registry returned invalid JSON');
  }
  const latest =
    body !== null &&
    typeof body === 'object' &&
    'dist-tags' in body &&
    (body as { 'dist-tags'?: unknown })['dist-tags'] !== null &&
    typeof (body as { 'dist-tags'?: unknown })['dist-tags'] === 'object'
      ? (body as { 'dist-tags': { latest?: unknown } })['dist-tags'].latest
      : undefined;
  if (typeof latest !== 'string' || parseVersion(latest) === undefined) {
    throw new Error('npm registry did not provide a valid latest version');
  }
  return latest;
}

function parseGeneratedArgs(value: string, profile: string): string | undefined {
  let args: unknown;
  try {
    args = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (!Array.isArray(args) || args.length !== 6) return undefined;
  const [yes, logLevel, packageArg, serve, profileFlag, profileName] = args;
  if (
    typeof yes !== 'string' ||
    typeof logLevel !== 'string' ||
    typeof packageArg !== 'string' ||
    typeof serve !== 'string' ||
    typeof profileFlag !== 'string' ||
    typeof profileName !== 'string' ||
    yes !== '--yes' ||
    logLevel !== '--loglevel=error' ||
    serve !== 'serve' ||
    profileFlag !== '--profile' ||
    profileName !== profile
  ) {
    return undefined;
  }
  const packageMatch = new RegExp(`^${PACKAGE_NAME.replace('/', '\\/')}@(.+)$`).exec(packageArg);
  return packageMatch?.[1] !== undefined && parseVersion(packageMatch[1]) !== undefined
    ? packageMatch[1]
    : undefined;
}

function findGeneratedCodexLaunchers(content: string, profile: string): LauncherMatch[] {
  const table = /^\[mcp_servers\.([A-Za-z0-9_-]+)\][ \t]*(?:#.*)?$/gm;
  const tables = [...content.matchAll(table)];
  const matches: LauncherMatch[] = [];

  for (const [index, tableMatch] of tables.entries()) {
    const configName = tableMatch[1];
    if (configName === undefined) continue;
    const sectionStart = tableMatch.index ?? 0;
    const sectionEnd = tables[index + 1]?.index ?? content.length;
    const section = content.slice(sectionStart, sectionEnd);
    const commandMatches = [...section.matchAll(/^command\s*=\s*"npx"\s*(?:#.*)?$/gm)];
    const argsMatches = [...section.matchAll(/^args\s*=\s*(\[[^\r\n]*\])\s*(?:#.*)?$/gm)];
    if (commandMatches.length !== 1 || argsMatches.length !== 1) continue;

    const argsMatch = argsMatches[0];
    if (argsMatch === undefined) continue;
    const argsText = argsMatch[1];
    if (argsText === undefined) continue;
    const argsLine = argsMatch[0];
    if (argsLine === undefined) continue;
    const currentVersion = parseGeneratedArgs(argsText, profile);
    if (currentVersion === undefined) continue;

    const argsStart = sectionStart + (argsMatch.index ?? 0) + argsLine.indexOf(argsText);
    matches.push({
      configName,
      sectionStart,
      sectionEnd,
      argsStart,
      argsEnd: argsStart + argsText.length,
      currentVersion,
    });
  }

  return matches;
}

interface GeneratedCodexLauncherFile {
  readonly configPath: string;
  readonly storage: ConfigStorage;
  readonly config: string;
  readonly launcher: LauncherMatch;
  readonly section: string;
  readonly serverSettings: string;
}

function topLevelTomlTable(section: string): string {
  const firstNewline = section.indexOf('\n');
  if (firstNewline === -1) return section;
  const afterHeader = section.slice(firstNewline + 1);
  const nextTable = afterHeader.search(/^\[/m);
  return nextTable === -1 ? section : section.slice(0, firstNewline + 1 + nextTable);
}

function migrateGeneratedCodexLauncherSettings(
  config: string,
  launcher: LauncherMatch,
): { config: string; settingsMigrated: readonly string[] } {
  const section = config.slice(launcher.sectionStart, launcher.sectionEnd);
  if (/^tool_timeout_sec\s*=/m.test(topLevelTomlTable(section))) {
    return { config, settingsMigrated: [] };
  }

  const lineFeed = config.indexOf('\n', launcher.argsEnd);
  if (lineFeed !== -1 && lineFeed < launcher.sectionEnd) {
    const newline = config[lineFeed - 1] === '\r' ? '\r\n' : '\n';
    const insertionPoint = lineFeed + 1;
    return {
      config: `${config.slice(0, insertionPoint)}tool_timeout_sec = ${RECOMMENDED_CODEX_TOOL_TIMEOUT_SEC}${newline}${config.slice(insertionPoint)}`,
      settingsMigrated: ['tool_timeout_sec'],
    };
  }

  const insertionPoint = launcher.sectionEnd;
  const separator = config.slice(0, insertionPoint).endsWith('\n') ? '' : '\n';
  return {
    config: `${config.slice(0, insertionPoint)}${separator}tool_timeout_sec = ${RECOMMENDED_CODEX_TOOL_TIMEOUT_SEC}\n${config.slice(insertionPoint)}`,
    settingsMigrated: ['tool_timeout_sec'],
  };
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

function sameFileIdentity(expected: Stats, actual: Stats): boolean {
  if (expected.ino !== actual.ino || expected.ino === 0) return false;
  if (expected.dev === actual.dev) return true;
  return process.platform === 'win32' && (expected.dev === 0 || actual.dev === 0);
}

function inspectConfigDirectory(path: string): { readonly path: string; readonly identity: Stats } {
  const expected = lstatSync(path);
  if (expected.isSymbolicLink() || !expected.isDirectory()) {
    throw new Error('Codex configuration parent must be a regular directory');
  }
  const canonicalPath = realpathSync(path);
  const actual = lstatSync(canonicalPath);
  if (actual.isSymbolicLink() || !actual.isDirectory() || !sameFileIdentity(expected, actual)) {
    throw new Error('Codex configuration parent changed while opening');
  }
  return { path: canonicalPath, identity: actual };
}

function resolveConfigLocation(
  options: Pick<UpdateOptions, 'config' | 'homeDirectory' | 'env'>,
): ConfigLocation {
  const requestedPath = resolveCodexConfigPath(options);
  const parent = dirname(requestedPath);
  let directory: ReturnType<typeof inspectConfigDirectory>;
  try {
    directory = inspectConfigDirectory(parent);
  } catch (error) {
    if (missing(error)) {
      throw new CodexLauncherUpdateError('config-missing', `Expected ${requestedPath}.`);
    }
    throw error;
  }
  return {
    requestedPath,
    storagePath: join(directory.path, basename(requestedPath)),
    directoryIdentity: directory.identity,
  };
}

function inspectConfigFile(path: string): Stats {
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size > MAX_CONFIG_BYTES) {
    throw new Error('Codex configuration must be a bounded regular file');
  }
  return metadata;
}

function readBounded(descriptor: number): Buffer {
  const chunks: Buffer[] = [];
  let total = 0;
  while (total <= MAX_CONFIG_BYTES) {
    const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, MAX_CONFIG_BYTES + 1 - total));
    const bytesRead = readSync(descriptor, chunk, 0, chunk.length, null);
    if (bytesRead === 0) break;
    chunks.push(chunk.subarray(0, bytesRead));
    total += bytesRead;
  }
  if (total > MAX_CONFIG_BYTES) {
    throw new Error('Codex configuration must be a bounded regular file');
  }
  return Buffer.concat(chunks, total);
}

function contentDigest(content: Uint8Array | string): string {
  return createHash('sha256').update(content).digest('hex');
}

function readStoredConfig(location: ConfigLocation): StoredConfig {
  try {
    const directory = inspectConfigDirectory(dirname(location.storagePath));
    if (!sameFileIdentity(location.directoryIdentity, directory.identity)) {
      throw new Error('Codex configuration parent changed while opening');
    }
  } catch (error) {
    throw new CodexLauncherUpdateError(
      'config-read',
      error instanceof Error ? error.message : String(error),
    );
  }
  let expected: Stats;
  try {
    expected = inspectConfigFile(location.storagePath);
  } catch (error) {
    if (missing(error)) {
      throw new CodexLauncherUpdateError('config-missing', `Expected ${location.requestedPath}.`);
    }
    throw new CodexLauncherUpdateError(
      'config-read',
      error instanceof Error ? error.message : String(error),
    );
  }
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      location.storagePath,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
    );
    const actual = fstatSync(descriptor);
    if (!actual.isFile() || actual.size > MAX_CONFIG_BYTES || !sameFileIdentity(expected, actual)) {
      throw new Error('Codex configuration changed while opening');
    }
    const bytes = readBounded(descriptor);
    const afterRead = fstatSync(descriptor);
    if (
      !afterRead.isFile() ||
      afterRead.size !== actual.size ||
      afterRead.mtimeMs !== actual.mtimeMs ||
      afterRead.ctimeMs !== actual.ctimeMs ||
      !sameFileIdentity(actual, afterRead)
    ) {
      throw new Error('Codex configuration changed while reading');
    }
    const directory = inspectConfigDirectory(dirname(location.storagePath));
    if (!sameFileIdentity(location.directoryIdentity, directory.identity)) {
      throw new Error('Codex configuration parent changed while reading');
    }
    return {
      location,
      config: bytes.toString('utf8'),
      contentDigest: contentDigest(bytes),
      identity: afterRead,
    };
  } catch (error) {
    if (error instanceof CodexLauncherUpdateError) throw error;
    throw new CodexLauncherUpdateError(
      'config-read',
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function readGeneratedCodexLauncher(
  profile: DiscordMcpProfile,
  options: Pick<UpdateOptions, 'config' | 'homeDirectory' | 'env'>,
): GeneratedCodexLauncherFile {
  let location: ConfigLocation;
  try {
    location = resolveConfigLocation(options);
  } catch (error) {
    if (error instanceof CodexLauncherUpdateError) throw error;
    throw new CodexLauncherUpdateError(
      'config-read',
      error instanceof Error ? error.message : String(error),
    );
  }
  const stored = readStoredConfig(location);
  const config = stored.config;

  const launchers = findGeneratedCodexLaunchers(config, profile.name);
  if (launchers.length === 0) {
    throw new CodexLauncherUpdateError(
      'launcher-unrecognized',
      'No exact npx launcher for this profile was found. Custom wrappers are left unchanged.',
    );
  }
  if (launchers.length > 1) {
    throw new CodexLauncherUpdateError(
      'launcher-ambiguous',
      `Found ${launchers.length} matching launchers. Remove the ambiguity before retrying.`,
    );
  }

  const launcher = launchers[0];
  if (launcher === undefined) {
    throw new CodexLauncherUpdateError(
      'launcher-unrecognized',
      'No exact npx launcher for this profile was found.',
    );
  }

  return {
    configPath: location.requestedPath,
    storage: {
      location,
      fileIdentity: stored.identity,
      contentDigest: stored.contentDigest,
    },
    config,
    launcher,
    section: config.slice(launcher.sectionStart, launcher.sectionEnd),
    serverSettings: topLevelTomlTable(config.slice(launcher.sectionStart, launcher.sectionEnd)),
  };
}

function escapedRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function tomlNumber(section: string, key: string): number | undefined {
  const match = new RegExp(
    `^${escapedRegExp(key)}\\s*=\\s*(\\d+(?:\\.\\d+)?)\\s*(?:#.*)?$`,
    'm',
  ).exec(section);
  if (match?.[1] === undefined) return undefined;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : undefined;
}

function tomlBoolean(section: string, key: string): boolean | undefined {
  const match = new RegExp(`^${escapedRegExp(key)}\\s*=\\s*(true|false)\\s*(?:#.*)?$`, 'm').exec(
    section,
  );
  if (match?.[1] === 'true') return true;
  if (match?.[1] === 'false') return false;
  return undefined;
}

function codexEnvTable(section: string, configName: string): string | undefined {
  const header = new RegExp(
    `^\\[mcp_servers\\.${escapedRegExp(configName)}\\.env\\]\\s*(?:#.*)?$`,
    'm',
  ).exec(section);
  if (header === null || header.index === undefined) return undefined;
  const afterHeader = section.slice(header.index + header[0].length);
  const nextTable = afterHeader.search(/^\[/m);
  return afterHeader.slice(0, nextTable === -1 ? afterHeader.length : nextTable);
}

function tomlEnvBoolean(section: string, configName: string, key: string): boolean | null {
  const env = codexEnvTable(section, configName);
  if (env === undefined) return null;
  const match = new RegExp(
    `^${escapedRegExp(key)}\\s*=\\s*("(?:[^"\\\\]|\\\\.)*")\\s*(?:#.*)?$`,
    'm',
  ).exec(env);
  if (match?.[1] === undefined) return null;
  try {
    const value: unknown = JSON.parse(match[1]);
    if (value === 'true') return true;
    if (value === 'false') return false;
  } catch {
    // The caller gets an unknown state; raw TOML must never reach doctor output.
  }
  return null;
}

function tomlEnvWriteMode(section: string, configName: string): 'allow' | 'preview' | null {
  const env = codexEnvTable(section, configName);
  if (env === undefined) return 'allow';
  const match = /^MCP_WRITE_MODE\s*=\s*("(?:[^"\\]|\\.)*")\s*(?:#.*)?$/m.exec(env);
  if (match?.[1] === undefined) return 'allow';
  try {
    const value: unknown = JSON.parse(match[1]);
    return value === 'allow' || value === 'preview' ? value : null;
  } catch {
    // Raw TOML must never reach doctor output.
    return null;
  }
}

/**
 * Read one generated Codex launcher without any registry, Discord, or write
 * operation. The returned metadata is deliberately secret-safe for doctor.
 */
export function inspectCodexClientConfig(
  profile: DiscordMcpProfile,
  options: Pick<UpdateOptions, 'config' | 'homeDirectory' | 'env'> = {},
): CodexClientConfigInspection {
  const source = readGeneratedCodexLauncher(profile, options);
  const startupTimeoutSec =
    tomlNumber(source.serverSettings, 'startup_timeout_sec') ??
    (() => {
      const milliseconds = tomlNumber(source.serverSettings, 'startup_timeout_ms');
      return milliseconds === undefined ? null : milliseconds / 1_000;
    })();

  return {
    configName: source.launcher.configName,
    currentVersion: source.launcher.currentVersion,
    enabled: tomlBoolean(source.serverSettings, 'enabled') ?? true,
    startupTimeoutSec,
    dryRun: tomlEnvBoolean(source.section, source.launcher.configName, 'MCP_DRY_RUN'),
    writeMode: tomlEnvWriteMode(source.section, source.launcher.configName),
    otelEnabled: tomlEnvBoolean(source.section, source.launcher.configName, 'OTEL_ENABLED'),
  };
}

function assertConfigUnchanged(stored: StoredConfig, expected: ConfigStorage): void {
  if (
    !sameFileIdentity(expected.fileIdentity, stored.identity) ||
    stored.contentDigest !== expected.contentDigest
  ) {
    throw new Error('Codex configuration changed while updating');
  }
}

function writeAtomically(storage: ConfigStorage, content: string): void {
  const path = storage.location.storagePath;
  const directory = dirname(path);
  const current = readStoredConfig(storage.location);
  assertConfigUnchanged(current, storage);
  const temporary = join(directory, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  let descriptor: number | undefined;
  let temporaryIdentity: Stats | undefined;
  try {
    const contentBytes = Buffer.byteLength(content, 'utf8');
    if (contentBytes > MAX_CONFIG_BYTES) {
      throw new Error('Codex configuration must be a bounded regular file');
    }
    descriptor = openSync(
      temporary,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        (fsConstants.O_NOFOLLOW ?? 0),
      current.identity.mode & 0o777,
    );
    temporaryIdentity = fstatSync(descriptor);
    if (!temporaryIdentity.isFile()) {
      throw new Error('Codex configuration temporary file is unsafe');
    }
    writeFileSync(descriptor, content, { encoding: 'utf8' });
    if (process.platform !== 'win32') fchmodSync(descriptor, current.identity.mode & 0o777);
    fsyncSync(descriptor);
    const finalTemporaryIdentity = fstatSync(descriptor);
    if (
      !finalTemporaryIdentity.isFile() ||
      finalTemporaryIdentity.size !== contentBytes ||
      finalTemporaryIdentity.size > MAX_CONFIG_BYTES ||
      !sameFileIdentity(temporaryIdentity, finalTemporaryIdentity)
    ) {
      throw new Error('Codex configuration temporary file changed while writing');
    }
    closeSync(descriptor);
    descriptor = undefined;
    const prepared = inspectConfigFile(temporary);
    if (prepared.size !== contentBytes || !sameFileIdentity(temporaryIdentity, prepared)) {
      throw new Error('Codex configuration temporary file changed before publishing');
    }
    const revalidated = readStoredConfig(storage.location);
    assertConfigUnchanged(revalidated, storage);
    renameSync(temporary, path);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (temporaryIdentity !== undefined) {
      try {
        const currentTemporary = lstatSync(temporary);
        if (
          !currentTemporary.isSymbolicLink() &&
          currentTemporary.isFile() &&
          sameFileIdentity(temporaryIdentity, currentTemporary)
        ) {
          unlinkSync(temporary);
        }
      } catch (error) {
        if (!missing(error)) {
          // Best-effort cleanup must not replace the original update error.
        }
      }
    }
  }
}

async function inspectCodexLauncherUpdateInternal(
  profile: DiscordMcpProfile,
  options: Pick<UpdateOptions, 'config' | 'homeDirectory' | 'env'> = {},
): Promise<InternalCodexLauncherUpdateInspection> {
  const source = readGeneratedCodexLauncher(profile, options);

  let targetVersion: string;
  try {
    targetVersion = await latestPublishedVersion();
  } catch (error) {
    throw new CodexLauncherUpdateError(
      'registry-unavailable',
      error instanceof Error ? error.message : String(error),
    );
  }

  const comparison = compareVersions(targetVersion, source.launcher.currentVersion);
  if (comparison === undefined) {
    throw new CodexLauncherUpdateError(
      'version-unsafe',
      `Current version: ${source.launcher.currentVersion}; registry version: ${targetVersion}`,
    );
  }

  return {
    configPath: source.configPath,
    storage: source.storage,
    config: source.config,
    launcher: source.launcher,
    currentVersion: source.launcher.currentVersion,
    targetVersion,
    updateAvailable: comparison > 0,
  };
}

export async function inspectCodexLauncherUpdate(
  profile: DiscordMcpProfile,
  options: Pick<UpdateOptions, 'config' | 'homeDirectory' | 'env'> = {},
): Promise<CodexLauncherUpdateInspection> {
  const inspection = await inspectCodexLauncherUpdateInternal(profile, options);
  return {
    configPath: inspection.configPath,
    config: inspection.config,
    launcher: inspection.launcher,
    currentVersion: inspection.currentVersion,
    targetVersion: inspection.targetVersion,
    updateAvailable: inspection.updateAvailable,
  };
}

function emitInspectionError(error: unknown, asJson: boolean): void {
  if (error instanceof CodexLauncherUpdateError) {
    const result =
      error.kind === 'config-missing'
        ? {
            summary: 'could not find the Codex configuration file',
            errors: [
              `${error.message} Run setup again or pass --config <path> for a nonstandard location.`,
            ],
          }
        : error.kind === 'config-read'
          ? { summary: 'could not read the Codex configuration file', errors: [error.message] }
          : error.kind === 'launcher-unrecognized' || error.kind === 'launcher-ambiguous'
            ? {
                summary: 'could not identify exactly one generated Codex launcher',
                errors: [error.message],
              }
            : error.kind === 'registry-unavailable'
              ? { summary: 'could not check for an update', errors: [error.message] }
              : { summary: 'could not compare package versions safely', errors: [error.message] };
    emitResult({ ok: false, exitCode: 2, ...result }, asJson);
    return;
  }

  emitResult(
    {
      ok: false,
      exitCode: 2,
      summary: 'could not check for an update',
      errors: [error instanceof Error ? error.message : String(error)],
    },
    asJson,
  );
}

export async function updateAction(options: UpdateOptions): Promise<void> {
  if (options.apply === true && options.check === true) {
    emitResult(
      {
        ok: false,
        exitCode: 2,
        summary: '--check and --apply cannot be used together',
        errors: ['Use --check (or no action flag) to inspect, then rerun with --apply.'],
      },
      options.json === true,
    );
    return;
  }

  let profile: DiscordMcpProfile;
  try {
    profile = loadProfile(options.profile, {
      ...(options.profileDirectory === undefined ? {} : { directory: options.profileDirectory }),
    });
  } catch (error) {
    emitResult(
      {
        ok: false,
        exitCode: 2,
        summary: `could not load profile ${options.profile}`,
        errors: [error instanceof Error ? error.message : String(error)],
      },
      options.json === true,
    );
    return;
  }
  if (profile.client !== 'codex') {
    emitResult(
      {
        ok: false,
        exitCode: 2,
        summary: `profile ${profile.name} is not a Codex profile`,
        errors: ['Only generated Codex launchers are supported by discord-mcp update.'],
      },
      options.json === true,
    );
    return;
  }

  let inspection: InternalCodexLauncherUpdateInspection;
  try {
    inspection = await inspectCodexLauncherUpdateInternal(profile, options);
  } catch (error) {
    emitInspectionError(error, options.json === true);
    return;
  }

  if (!inspection.updateAvailable) {
    emitResult(
      {
        ok: true,
        exitCode: 0,
        summary: `discord-mcp is up to date (${inspection.currentVersion})`,
        details: [`Profile: ${profile.name}`, 'No bot token or Discord data was sent to npm.'],
        data: {
          package: PACKAGE_NAME,
          profile: profile.name,
          currentVersion: inspection.currentVersion,
          targetVersion: inspection.targetVersion,
          updateAvailable: false,
        },
      },
      options.json === true,
    );
    return;
  }

  if (options.apply !== true) {
    emitResult(
      {
        ok: false,
        exitCode: 1,
        summary: `update available: ${inspection.currentVersion} -> ${inspection.targetVersion}`,
        details: [
          `Profile: ${profile.name}`,
          `Apply explicitly: discord-mcp update --profile ${profile.name} --apply`,
          'No bot token, Discord identity, guild, or profile data was sent to npm.',
        ],
        warnings: ['The launcher remains pinned until you explicitly run --apply.'],
        data: {
          package: PACKAGE_NAME,
          profile: profile.name,
          currentVersion: inspection.currentVersion,
          targetVersion: inspection.targetVersion,
          updateAvailable: true,
        },
      },
      options.json === true,
    );
    return;
  }

  const migration = migrateGeneratedCodexLauncherSettings(inspection.config, inspection.launcher);
  const args = migration.config.slice(inspection.launcher.argsStart, inspection.launcher.argsEnd);
  const nextArgs = args.replace(
    `${PACKAGE_NAME}@${inspection.launcher.currentVersion}`,
    `${PACKAGE_NAME}@${inspection.targetVersion}`,
  );
  const updatedConfig = `${migration.config.slice(0, inspection.launcher.argsStart)}${nextArgs}${migration.config.slice(inspection.launcher.argsEnd)}`;
  try {
    writeAtomically(inspection.storage, updatedConfig);
  } catch (error) {
    emitResult(
      {
        ok: false,
        exitCode: 2,
        summary: 'could not update the Codex configuration file',
        errors: [error instanceof Error ? error.message : String(error)],
      },
      options.json === true,
    );
    return;
  }

  emitResult(
    {
      ok: true,
      exitCode: 0,
      summary: `updated Codex launcher: ${inspection.launcher.currentVersion} -> ${inspection.targetVersion}`,
      details: [
        `Profile: ${profile.name}`,
        `Server: ${inspection.launcher.configName}`,
        ...(migration.settingsMigrated.length === 0
          ? []
          : ['Codex settings: added tool_timeout_sec = 180.']),
        'Restart Codex to start the newly pinned version.',
      ],
      data: {
        package: PACKAGE_NAME,
        profile: profile.name,
        currentVersion: inspection.launcher.currentVersion,
        targetVersion: inspection.targetVersion,
        updateAvailable: true,
        applied: true,
        restart_required: true,
        settings_migrated: migration.settingsMigrated,
      },
    },
    options.json === true,
  );
}
