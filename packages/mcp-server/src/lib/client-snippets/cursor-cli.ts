/**
 * Cursor Agent CLI MCP server snippet generator.
 *
 * Cursor Agent inherits the environment that launches it. Keep both the
 * caller-owned Discord token and Cursor model credential out of mcp.json;
 * the generated local stdio server receives only inherited process state.
 */
import { renderMcpServersJson } from './_shared.js';
import type { ClientGenerator, Snippet, SnippetConfig } from './types.js';

const CONFIG_PATH = [
  'Global:           ~/.cursor/mcp.json',
  'Project-level:    <project>/.cursor/mcp.json',
].join('\n');

const INSTRUCTIONS =
  'Merge the snippet into Cursor mcp.json and launch cursor-agent with DISCORD_TOKEN set. Authenticate Cursor normally; if you use CURSOR_API_KEY, keep it in the launch environment. Neither credential is stored in mcp.json. For automation, define deny-by-default permissions in .cursor/cli.json and allow only the exact discord-mcp tools required by the workflow. Verify the saved launcher with `discord-mcp doctor --client cursor-cli --profile <name>`.';

export const cursorCliGenerator: ClientGenerator = {
  id: 'cursor-cli',
  displayName: 'Cursor Agent CLI',
  generate(cfg: SnippetConfig): Snippet {
    const { discordToken: _discordToken, envVars, ...baseConfig } = cfg;
    const secretFreeEnvVars = Object.fromEntries(
      Object.entries(envVars ?? {}).filter(
        ([name]) => !['DISCORD_TOKEN', 'CURSOR_API_KEY'].includes(name.toUpperCase()),
      ),
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
