import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { emitResult } from '../lib/output.js';
import { type DiscordMcpProfile, loadProfile } from '../lib/profiles.js';

const PACKAGE_NAME = '@discord-mcp/cli';
const REGISTRY_URL = 'https://registry.npmjs.org/@discord-mcp%2fcli';
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
  registryUrl?: string;
}

interface VersionParts {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease?: string;
}

export interface LauncherMatch {
  readonly configName: string;
  readonly argsStart: number;
  readonly argsEnd: number;
  readonly currentVersion: string;
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

async function latestPublishedVersion(registryUrl = REGISTRY_URL): Promise<string> {
  let response: Response;
  try {
    response = await fetch(registryUrl, {
      headers: { accept: 'application/json' },
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
      argsStart,
      argsEnd: argsStart + argsText.length,
      currentVersion,
    });
  }

  return matches;
}

function writeAtomically(path: string, content: string): void {
  const directory = dirname(path);
  const mode = statSync(path).mode & 0o777;
  const temporary = join(directory, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, content, { encoding: 'utf8', flag: 'wx', mode });
    renameSync(temporary, path);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

export async function inspectCodexLauncherUpdate(
  profile: DiscordMcpProfile,
  options: Pick<UpdateOptions, 'config' | 'homeDirectory' | 'env' | 'registryUrl'> = {},
): Promise<CodexLauncherUpdateInspection> {
  const configPath = resolveCodexConfigPath(options);
  if (!existsSync(configPath)) {
    throw new CodexLauncherUpdateError('config-missing', `Expected ${configPath}.`);
  }

  let config: string;
  try {
    config = readFileSync(configPath, 'utf8');
  } catch (error) {
    throw new CodexLauncherUpdateError(
      'config-read',
      error instanceof Error ? error.message : String(error),
    );
  }

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

  let targetVersion: string;
  try {
    targetVersion = await latestPublishedVersion(options.registryUrl);
  } catch (error) {
    throw new CodexLauncherUpdateError(
      'registry-unavailable',
      error instanceof Error ? error.message : String(error),
    );
  }

  const comparison = compareVersions(targetVersion, launcher.currentVersion);
  if (comparison === undefined) {
    throw new CodexLauncherUpdateError(
      'version-unsafe',
      `Current version: ${launcher.currentVersion}; registry version: ${targetVersion}`,
    );
  }

  return {
    configPath,
    config,
    launcher,
    currentVersion: launcher.currentVersion,
    targetVersion,
    updateAvailable: comparison > 0,
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

  let inspection: CodexLauncherUpdateInspection;
  try {
    inspection = await inspectCodexLauncherUpdate(profile, options);
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

  const args = inspection.config.slice(inspection.launcher.argsStart, inspection.launcher.argsEnd);
  const nextArgs = args.replace(
    `${PACKAGE_NAME}@${inspection.launcher.currentVersion}`,
    `${PACKAGE_NAME}@${inspection.targetVersion}`,
  );
  const updatedConfig = `${inspection.config.slice(0, inspection.launcher.argsStart)}${nextArgs}${inspection.config.slice(inspection.launcher.argsEnd)}`;
  try {
    writeAtomically(inspection.configPath, updatedConfig);
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
        'Restart Codex to start the newly pinned version.',
      ],
      data: {
        package: PACKAGE_NAME,
        profile: profile.name,
        currentVersion: inspection.launcher.currentVersion,
        targetVersion: inspection.targetVersion,
        updateAvailable: true,
        applied: true,
      },
    },
    options.json === true,
  );
}
