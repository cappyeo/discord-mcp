import { lstatSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import type { DiscordMcpProfile } from '../profiles.js';

export type GrokCliConfigErrorKind =
  | 'config-missing'
  | 'config-read'
  | 'config-invalid'
  | 'launcher-unrecognized'
  | 'credential-persisted';

export class GrokCliConfigError extends Error {
  constructor(
    readonly kind: GrokCliConfigErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'GrokCliConfigError';
  }
}

export interface GrokCliConfigInspection {
  readonly configName: 'discord-mcp';
  readonly currentVersion: string;
  readonly environmentForwarding: 'inherited';
  readonly credentialPersisted: false;
}

export interface GrokCliConfigOptions {
  readonly config?: string;
  readonly homeDirectory?: string;
  readonly environment?: NodeJS.ProcessEnv;
}

const MAX_CONFIG_BYTES = 1024 * 1024;
const RELEASE = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/u;
const TABLE = /^\s*\[([^\]]+)\]\s*(?:#.*)?$/u;
const CREDENTIAL = /\b(?:DISCORD_TOKEN|XAI_API_KEY|GROK_API_KEY|GROK_CODE_XAI_API_KEY)\b/iu;

function configPath(options: GrokCliConfigOptions): string {
  if (options.config !== undefined)
    return isAbsolute(options.config) ? options.config : resolve(options.config);
  const grokHome = (options.environment ?? process.env).GROK_HOME;
  if (typeof grokHome === 'string' && grokHome.trim() !== '')
    return resolve(grokHome, 'config.toml');
  return join(options.homeDirectory ?? homedir(), '.grok', 'config.toml');
}

function readConfig(options: GrokCliConfigOptions): string {
  const path = configPath(options);
  let metadata: ReturnType<typeof lstatSync>;
  try {
    metadata = lstatSync(path);
  } catch {
    throw new GrokCliConfigError('config-missing', 'Grok Build MCP config could not be found');
  }
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size > MAX_CONFIG_BYTES)
    throw new GrokCliConfigError(
      'config-read',
      'Grok Build MCP config must be a bounded regular file',
    );
  try {
    return readFileSync(path, 'utf8');
  } catch {
    throw new GrokCliConfigError('config-read', 'could not read Grok Build MCP config');
  }
}

function selectedSections(source: string): { server: string; environment: string } {
  const selected = { server: '', environment: '' };
  const seen = new Set<keyof typeof selected>();
  let section: keyof typeof selected | null = null;
  for (const line of source.split(/\r?\n/u)) {
    const table = TABLE.exec(line);
    if (table !== null) {
      const nextSection =
        table[1] === 'mcp_servers.discord-mcp'
          ? 'server'
          : table[1] === 'mcp_servers.discord-mcp.env'
            ? 'environment'
            : null;
      if (nextSection !== null) {
        if (seen.has(nextSection))
          throw new GrokCliConfigError('config-invalid', 'Grok Build MCP table is duplicated');
        seen.add(nextSection);
      }
      section = nextSection;
      continue;
    }
    if (section !== null) selected[section] += `${line}\n`;
  }
  return selected;
}

function generatedAssignments(section: string, allowed: ReadonlySet<string>): Map<string, unknown> {
  const values = new Map<string, unknown>();
  for (const line of section.split(/\r?\n/u)) {
    if (line.trim() === '') continue;
    const assignment = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+?)\s*$/u.exec(line);
    const key = assignment?.[1];
    const encoded = assignment?.[2];
    if (key === undefined || encoded === undefined || !allowed.has(key) || values.has(key))
      throw new GrokCliConfigError(
        'config-invalid',
        'Grok Build MCP config is not an exact generated fragment',
      );
    try {
      values.set(key, JSON.parse(encoded));
    } catch {
      throw new GrokCliConfigError('config-invalid', 'could not parse Grok Build MCP config');
    }
  }
  return values;
}

/** Inspect the generated Grok Build TOML without returning credential values. */
export function inspectGrokCliConfig(
  profile: DiscordMcpProfile,
  options: GrokCliConfigOptions = {},
): GrokCliConfigInspection {
  if (profile.client !== 'grok-cli')
    throw new GrokCliConfigError(
      'launcher-unrecognized',
      'the selected profile was not generated for Grok Build CLI',
    );
  const sections = selectedSections(readConfig(options));
  if (sections.server === '')
    throw new GrokCliConfigError(
      'launcher-unrecognized',
      'Grok Build config does not contain the generated discord-mcp launcher',
    );
  if (CREDENTIAL.test(sections.server) || CREDENTIAL.test(sections.environment))
    throw new GrokCliConfigError(
      'credential-persisted',
      'Grok Build MCP config must inherit credentials instead of storing them',
    );
  const server = generatedAssignments(
    sections.server,
    new Set(['command', 'args', 'enabled', 'startup_timeout_sec', 'tool_timeout_sec']),
  );
  if (sections.environment !== '')
    generatedAssignments(
      sections.environment,
      new Set(
        sections.environment
          .split(/\r?\n/u)
          .map((line) => /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/u.exec(line)?.[1])
          .filter((key): key is string => key !== undefined),
      ),
    );
  const command = server.get('command');
  const args = server.get('args');
  const enabled = server.get('enabled');
  if (
    server.size !== 5 ||
    command !== 'npx' ||
    enabled !== true ||
    server.get('startup_timeout_sec') !== 90 ||
    server.get('tool_timeout_sec') !== 180 ||
    !Array.isArray(args) ||
    args.length !== 6 ||
    args[0] !== '--yes' ||
    args[1] !== '--loglevel=error' ||
    typeof args[2] !== 'string' ||
    args[3] !== 'serve' ||
    args[4] !== '--profile' ||
    args[5] !== profile.name
  )
    throw new GrokCliConfigError(
      'launcher-unrecognized',
      'generated Grok Build launcher is not bound to the selected profile',
    );
  const packageMatch = /^@discord-mcp\/cli@(.+)$/u.exec(args[2]);
  if (packageMatch?.[1] === undefined || !RELEASE.test(packageMatch[1]))
    throw new GrokCliConfigError(
      'launcher-unrecognized',
      'generated Grok Build launcher has an invalid package version',
    );
  return {
    configName: 'discord-mcp',
    currentVersion: packageMatch[1],
    environmentForwarding: 'inherited',
    credentialPersisted: false,
  };
}
