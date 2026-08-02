/**
 * Codex MCP server configuration generator.
 *
 * Codex configures local stdio servers in `~/.codex/config.toml`. The safe
 * default forwards `DISCORD_TOKEN` from the environment with `env_vars`
 * instead of persisting a token in Codex's configuration file.
 */
import type { ClientGenerator, Snippet, SnippetConfig } from './types.js';

const CONFIG_PATH = 'User-level: ~/.codex/config.toml';

const INSTRUCTIONS =
  'Merge this TOML fragment into ~/.codex/config.toml. Set DISCORD_TOKEN in the environment before starting Codex; the default fragment forwards it without storing the token in config.toml.';

// biome-ignore lint/suspicious/noTemplateCurlyInString: literal placeholder passed by init
const TOKEN_PLACEHOLDER = '${env:DISCORD_TOKEN}';

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function renderTomlStringArray(values: readonly string[]): string {
  return `[${values.map(tomlString).join(', ')}]`;
}

function renderCodexToml(cfg: SnippetConfig): string {
  const args = [...(cfg.serverArgs ?? [])];
  if (cfg.gateway === true) {
    args.push('--gateway');
  }

  const lines = [
    '[mcp_servers.discord-mcp]',
    `command = ${tomlString(cfg.serverPath)}`,
    `args = ${renderTomlStringArray(args)}`,
  ];

  if (cfg.discordToken === undefined || cfg.discordToken === TOKEN_PLACEHOLDER) {
    lines.push('env_vars = ["DISCORD_TOKEN"]');
  }

  const env = {
    ...(cfg.discordToken === undefined || cfg.discordToken === TOKEN_PLACEHOLDER
      ? {}
      : { DISCORD_TOKEN: cfg.discordToken }),
    ...(cfg.envVars ?? {}),
  };

  if (Object.keys(env).length > 0) {
    lines.push('', '[mcp_servers.discord-mcp.env]');
    for (const [key, value] of Object.entries(env)) {
      lines.push(`${key} = ${tomlString(value)}`);
    }
  }

  return `${lines.join('\n')}\n`;
}

export const codexGenerator: ClientGenerator = {
  id: 'codex',
  displayName: 'Codex',
  generate(cfg: SnippetConfig): Snippet {
    return {
      format: 'toml',
      content: renderCodexToml(cfg),
      configFilePath: CONFIG_PATH,
      instructions: INSTRUCTIONS,
    };
  },
};
