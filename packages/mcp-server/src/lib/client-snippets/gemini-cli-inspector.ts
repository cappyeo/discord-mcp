import { lstatSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import type { DiscordMcpProfile } from '../profiles.js';

export type GeminiCliConfigErrorKind =
  | 'config-missing'
  | 'config-read'
  | 'config-invalid'
  | 'launcher-unrecognized'
  | 'credential-missing'
  | 'credential-materialized';

export class GeminiCliConfigError extends Error {
  constructor(
    readonly kind: GeminiCliConfigErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'GeminiCliConfigError';
  }
}

export interface GeminiCliConfigInspection {
  readonly configName: 'discord-mcp';
  readonly currentVersion: string;
  readonly environmentForwarding: true;
  readonly credentialPersisted: false;
}

export interface GeminiCliConfigOptions {
  readonly config?: string;
  readonly homeDirectory?: string;
  readonly env?: NodeJS.ProcessEnv;
}

const MAX_CONFIG_BYTES = 1024 * 1024;
const RELEASE = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;
// biome-ignore lint/suspicious/noTemplateCurlyInString: literal Gemini interpolation
const TOKEN_REFERENCE = '${DISCORD_TOKEN}';

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function configPath(options: GeminiCliConfigOptions): string {
  if (options.config !== undefined) {
    return isAbsolute(options.config) ? options.config : resolve(options.config);
  }
  const configuredHome = (options.env ?? process.env).GEMINI_CLI_HOME?.trim();
  const homeDirectory =
    options.homeDirectory ??
    (configuredHome === undefined || configuredHome === '' ? homedir() : resolve(configuredHome));
  return join(homeDirectory, '.gemini', 'settings.json');
}

function readSettings(options: GeminiCliConfigOptions): Record<string, unknown> {
  const path = configPath(options);
  let metadata: ReturnType<typeof lstatSync>;
  try {
    metadata = lstatSync(path);
  } catch {
    throw new GeminiCliConfigError('config-missing', 'Gemini CLI settings could not be found');
  }
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size > MAX_CONFIG_BYTES) {
    throw new GeminiCliConfigError(
      'config-read',
      'Gemini CLI settings must be a bounded regular file',
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new GeminiCliConfigError('config-invalid', 'could not parse Gemini CLI settings');
  }
  if (!record(parsed)) {
    throw new GeminiCliConfigError('config-invalid', 'Gemini CLI settings must be a JSON object');
  }
  return parsed;
}

/** Inspect one generated Gemini CLI launcher without returning config or credential values. */
export function inspectGeminiCliConfig(
  profile: DiscordMcpProfile,
  options: GeminiCliConfigOptions = {},
): GeminiCliConfigInspection {
  if (profile.client !== 'gemini-cli') {
    throw new GeminiCliConfigError(
      'launcher-unrecognized',
      'the selected profile was not generated for Gemini CLI',
    );
  }
  const settings = readSettings(options);
  const servers = settings.mcpServers;
  const server = record(servers) ? servers['discord-mcp'] : undefined;
  if (!record(server)) {
    throw new GeminiCliConfigError(
      'launcher-unrecognized',
      'Gemini CLI settings do not contain the generated discord-mcp launcher',
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
    throw new GeminiCliConfigError(
      'launcher-unrecognized',
      'generated Gemini CLI launcher is not bound to the selected profile',
    );
  }
  const packageMatch = /^@discord-mcp\/cli@(.+)$/u.exec(args[2]);
  if (packageMatch?.[1] === undefined || !RELEASE.test(packageMatch[1])) {
    throw new GeminiCliConfigError(
      'launcher-unrecognized',
      'generated Gemini CLI launcher has an invalid package version',
    );
  }

  const env = server.env;
  if (!record(env) || !Object.hasOwn(env, 'DISCORD_TOKEN')) {
    throw new GeminiCliConfigError(
      'credential-missing',
      'Gemini CLI must explicitly forward DISCORD_TOKEN to the MCP child',
    );
  }
  if (env.DISCORD_TOKEN !== TOKEN_REFERENCE) {
    throw new GeminiCliConfigError(
      'credential-materialized',
      'Gemini CLI settings contain a materialized credential instead of the environment reference',
    );
  }

  return {
    configName: 'discord-mcp',
    currentVersion: packageMatch[1],
    environmentForwarding: true,
    credentialPersisted: false,
  };
}
