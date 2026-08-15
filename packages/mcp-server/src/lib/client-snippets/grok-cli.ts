/**
 * Grok Build CLI MCP server snippet generator.
 *
 * Grok reads MCP servers from ~/.grok/config.toml (or $GROK_HOME/config.toml).
 * The caller-owned Discord token and optional xAI API key stay in the launch
 * environment; neither credential belongs in the generated fragment.
 */
import type { ClientGenerator, Snippet, SnippetConfig } from './types.js';

const CONFIG_PATH = 'User-level: ~/.grok/config.toml';
const INSTRUCTIONS =
  'Merge this TOML fragment into ~/.grok/config.toml (or $GROK_HOME/config.toml). Authenticate Grok with `grok login` or XAI_API_KEY, then launch it from an environment containing DISCORD_TOKEN; no credential is stored in this fragment. Grok Build inherits the launch environment for stdio MCP servers. Verify the saved launcher with `discord-mcp doctor --client grok-cli --profile <name>`.';
const CREDENTIAL_KEYS = new Set([
  'DISCORD_TOKEN',
  'XAI_API_KEY',
  'GROK_API_KEY',
  'GROK_CODE_XAI_API_KEY',
]);

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function renderTomlArray(values: readonly string[]): string {
  return `[${values.map(tomlString).join(', ')}]`;
}

function renderGrokToml(cfg: SnippetConfig): string {
  const args = [...(cfg.serverArgs ?? [])];
  if (cfg.gateway === true) args.push('--gateway');
  const lines = [
    '[mcp_servers.discord-mcp]',
    `command = ${tomlString(cfg.serverPath)}`,
    `args = ${renderTomlArray(args)}`,
    'enabled = true',
    'startup_timeout_sec = 90',
    'tool_timeout_sec = 180',
  ];
  const environment = Object.entries(cfg.envVars ?? {}).filter(
    ([name]) => !CREDENTIAL_KEYS.has(name.toUpperCase()),
  );
  if (environment.length > 0) {
    lines.push('', '[mcp_servers.discord-mcp.env]');
    for (const [name, value] of environment) lines.push(`${name} = ${tomlString(value)}`);
  }
  return `${lines.join('\n')}\n`;
}

export const grokCliGenerator: ClientGenerator = {
  id: 'grok-cli',
  displayName: 'Grok Build CLI',
  generate(cfg: SnippetConfig): Snippet {
    return {
      format: 'toml',
      content: renderGrokToml(cfg),
      configFilePath: CONFIG_PATH,
      instructions: INSTRUCTIONS,
    };
  },
};
