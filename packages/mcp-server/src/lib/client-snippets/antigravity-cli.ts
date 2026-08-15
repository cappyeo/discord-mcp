/**
 * Google Antigravity CLI MCP server snippet generator.
 *
 * Antigravity reads a dedicated `mcp_config.json` and inherits the launch
 * environment when it starts a local stdio server. Keep the caller-owned
 * Discord token out of the JSON entirely; the generated launcher reads
 * `DISCORD_TOKEN` from the environment that starts `agy`.
 */
import { renderMcpServersJson } from './_shared.js';
import type { ClientGenerator, Snippet, SnippetConfig } from './types.js';

const CONFIG_PATH = [
  'User-level:      ~/.gemini/config/mcp_config.json',
  'Project-level:   <project>/.agents/mcp_config.json',
].join('\n');

const INSTRUCTIONS =
  'Merge the snippet into `mcpServers` in Antigravity MCP config and launch `agy` with DISCORD_TOKEN set. The token is inherited by the local MCP process and is intentionally absent from mcp_config.json. Antigravity asks before unconfigured MCP actions; approve only the exact discord-mcp tool needed for the current operation. Verify the saved launcher with `discord-mcp doctor --client antigravity-cli --profile <name>`.';

export const antigravityCliGenerator: ClientGenerator = {
  id: 'antigravity-cli',
  displayName: 'Antigravity CLI',
  generate(cfg: SnippetConfig): Snippet {
    const { discordToken: _discordToken, envVars, ...baseConfig } = cfg;
    const secretFreeEnvVars = Object.fromEntries(
      Object.entries(envVars ?? {}).filter(([name]) => name.toUpperCase() !== 'DISCORD_TOKEN'),
    );
    const secretFreeConfig: SnippetConfig = {
      ...baseConfig,
      ...(Object.keys(secretFreeEnvVars).length === 0 ? {} : { envVars: secretFreeEnvVars }),
    };
    return {
      format: 'json',
      content: renderMcpServersJson(secretFreeConfig),
      configFilePath: CONFIG_PATH,
      instructions: INSTRUCTIONS,
    };
  },
};
