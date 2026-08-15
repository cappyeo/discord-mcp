import { lstatSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import type { DiscordMcpProfile } from '../profiles.js';

export type AntigravityCliConfigErrorKind =
  | 'config-missing'
  | 'config-read'
  | 'config-invalid'
  | 'launcher-unrecognized'
  | 'credential-persisted';

export class AntigravityCliConfigError extends Error {
  constructor(
    readonly kind: AntigravityCliConfigErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'AntigravityCliConfigError';
  }
}

export interface AntigravityCliConfigInspection {
  readonly configName: 'discord-mcp';
  readonly currentVersion: string;
  readonly environmentForwarding: 'inherited';
  readonly credentialPersisted: false;
}

export interface AntigravityCliConfigOptions {
  readonly config?: string;
  readonly homeDirectory?: string;
}

const MAX_CONFIG_BYTES = 1024 * 1024;
const RELEASE = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function configPath(options: AntigravityCliConfigOptions): string {
  if (options.config !== undefined) {
    return isAbsolute(options.config) ? options.config : resolve(options.config);
  }
  return join(options.homeDirectory ?? homedir(), '.gemini', 'config', 'mcp_config.json');
}

function readConfig(options: AntigravityCliConfigOptions): Record<string, unknown> {
  const path = configPath(options);
  let metadata: ReturnType<typeof lstatSync>;
  try {
    metadata = lstatSync(path);
  } catch {
    throw new AntigravityCliConfigError(
      'config-missing',
      'Antigravity CLI MCP config could not be found',
    );
  }
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size > MAX_CONFIG_BYTES) {
    throw new AntigravityCliConfigError(
      'config-read',
      'Antigravity CLI MCP config must be a bounded regular file',
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new AntigravityCliConfigError(
      'config-invalid',
      'could not parse Antigravity CLI MCP config',
    );
  }
  if (!record(parsed)) {
    throw new AntigravityCliConfigError(
      'config-invalid',
      'Antigravity CLI MCP config must be a JSON object',
    );
  }
  return parsed;
}

/** Inspect one generated Antigravity launcher without returning config or credential values. */
export function inspectAntigravityCliConfig(
  profile: DiscordMcpProfile,
  options: AntigravityCliConfigOptions = {},
): AntigravityCliConfigInspection {
  if (profile.client !== 'antigravity-cli') {
    throw new AntigravityCliConfigError(
      'launcher-unrecognized',
      'the selected profile was not generated for Antigravity CLI',
    );
  }
  const config = readConfig(options);
  const servers = config.mcpServers;
  const server = record(servers) ? servers['discord-mcp'] : undefined;
  if (!record(server)) {
    throw new AntigravityCliConfigError(
      'launcher-unrecognized',
      'Antigravity CLI MCP config does not contain the generated discord-mcp launcher',
    );
  }

  const args = server.args;
  if (
    server.command !== 'npx' ||
    !Array.isArray(args) ||
    args.length !== 6 ||
    args[0] !== '--yes' ||
    args[1] !== '--loglevel=error' ||
    typeof args[2] !== 'string' ||
    args[3] !== 'serve' ||
    args[4] !== '--profile' ||
    args[5] !== profile.name
  ) {
    throw new AntigravityCliConfigError(
      'launcher-unrecognized',
      'generated Antigravity CLI launcher is not bound to the selected profile',
    );
  }
  const packageMatch = /^@discord-mcp\/cli@(.+)$/u.exec(args[2]);
  if (packageMatch?.[1] === undefined || !RELEASE.test(packageMatch[1])) {
    throw new AntigravityCliConfigError(
      'launcher-unrecognized',
      'generated Antigravity CLI launcher has an invalid package version',
    );
  }

  if (
    record(server.env) &&
    Object.keys(server.env).some((name) => name.toUpperCase() === 'DISCORD_TOKEN')
  ) {
    throw new AntigravityCliConfigError(
      'credential-persisted',
      'Antigravity CLI MCP config must inherit DISCORD_TOKEN instead of storing it',
    );
  }

  return {
    configName: 'discord-mcp',
    currentVersion: packageMatch[1],
    environmentForwarding: 'inherited',
    credentialPersisted: false,
  };
}
