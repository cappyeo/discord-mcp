import { lstatSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import type { DiscordMcpProfile } from '../profiles.js';

export type CursorCliConfigErrorKind =
  | 'config-missing'
  | 'config-read'
  | 'config-invalid'
  | 'launcher-unrecognized'
  | 'credential-persisted';

export class CursorCliConfigError extends Error {
  constructor(
    readonly kind: CursorCliConfigErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'CursorCliConfigError';
  }
}

export interface CursorCliConfigInspection {
  readonly configName: 'discord-mcp';
  readonly currentVersion: string;
  readonly environmentForwarding: 'inherited';
  readonly credentialPersisted: false;
}

export interface CursorCliConfigOptions {
  readonly config?: string;
  readonly homeDirectory?: string;
}

const MAX_CONFIG_BYTES = 1024 * 1024;
const RELEASE = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;
const CREDENTIAL_NAMES = new Set(['DISCORD_TOKEN', 'CURSOR_API_KEY']);

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function containsCredentialName(value: unknown): boolean {
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (Array.isArray(current)) {
      pending.push(...current);
      continue;
    }
    if (!record(current)) {
      continue;
    }
    for (const [name, nested] of Object.entries(current)) {
      if (CREDENTIAL_NAMES.has(name.toUpperCase())) {
        return true;
      }
      pending.push(nested);
    }
  }
  return false;
}

function configPath(options: CursorCliConfigOptions): string {
  if (options.config !== undefined) {
    return isAbsolute(options.config) ? options.config : resolve(options.config);
  }
  return join(options.homeDirectory ?? homedir(), '.cursor', 'mcp.json');
}

function readConfig(options: CursorCliConfigOptions): Record<string, unknown> {
  const path = configPath(options);
  let metadata: ReturnType<typeof lstatSync>;
  try {
    metadata = lstatSync(path);
  } catch {
    throw new CursorCliConfigError('config-missing', 'Cursor Agent MCP config could not be found');
  }
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size > MAX_CONFIG_BYTES) {
    throw new CursorCliConfigError(
      'config-read',
      'Cursor Agent MCP config must be a bounded regular file',
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new CursorCliConfigError('config-invalid', 'could not parse Cursor Agent MCP config');
  }
  if (!record(parsed)) {
    throw new CursorCliConfigError(
      'config-invalid',
      'Cursor Agent MCP config must be a JSON object',
    );
  }
  return parsed;
}

/** Inspect one generated Cursor Agent launcher without returning config or credential values. */
export function inspectCursorCliConfig(
  profile: DiscordMcpProfile,
  options: CursorCliConfigOptions = {},
): CursorCliConfigInspection {
  if (profile.client !== 'cursor-cli') {
    throw new CursorCliConfigError(
      'launcher-unrecognized',
      'the selected profile was not generated for Cursor Agent CLI',
    );
  }
  const config = readConfig(options);
  if (containsCredentialName(config)) {
    throw new CursorCliConfigError(
      'credential-persisted',
      'Cursor Agent MCP config must inherit credentials instead of storing them',
    );
  }

  const servers = config.mcpServers;
  const server = record(servers) ? servers['discord-mcp'] : undefined;
  if (!record(server)) {
    throw new CursorCliConfigError(
      'launcher-unrecognized',
      'Cursor Agent MCP config does not contain the generated discord-mcp launcher',
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
    throw new CursorCliConfigError(
      'launcher-unrecognized',
      'generated Cursor Agent launcher is not bound to the selected profile',
    );
  }
  const packageMatch = /^@discord-mcp\/cli@(.+)$/u.exec(args[2]);
  if (packageMatch?.[1] === undefined || !RELEASE.test(packageMatch[1])) {
    throw new CursorCliConfigError(
      'launcher-unrecognized',
      'generated Cursor Agent launcher has an invalid package version',
    );
  }

  return {
    configName: 'discord-mcp',
    currentVersion: packageMatch[1],
    environmentForwarding: 'inherited',
    credentialPersisted: false,
  };
}
