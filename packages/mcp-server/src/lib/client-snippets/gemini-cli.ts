/**
 * Gemini CLI MCP server snippet generator.
 *
 * Gemini CLI reads the standard top-level `mcpServers` object from user or
 * project settings. Unlike most JSON clients, it removes inherited sensitive
 * environment variables before spawning an MCP child unless the server entry
 * explicitly opts into them. Keep `DISCORD_TOKEN` as an interpolation
 * reference even for guided profiles so the caller-owned secret stays outside
 * both the generated config and the local discord-mcp profile.
 */
import { renderMcpServersJson } from './_shared.js';
import type { ClientGenerator, Snippet, SnippetConfig } from './types.js';

// biome-ignore lint/suspicious/noTemplateCurlyInString: literal legacy placeholder
const LEGACY_TOKEN_PLACEHOLDER = '${env:DISCORD_TOKEN}';
// biome-ignore lint/suspicious/noTemplateCurlyInString: literal Gemini interpolation
const GEMINI_TOKEN_PLACEHOLDER = '${DISCORD_TOKEN}';

const CONFIG_PATH = [
  'User-level:      ~/.gemini/settings.json',
  'Project-level:   <project>/.gemini/settings.json',
].join('\n');

const INSTRUCTIONS =
  'Merge the snippet directly into `mcpServers` in Gemini settings and launch Gemini with DISCORD_TOKEN set. The explicit env reference is required because Gemini sanitizes inherited sensitive variables before spawning MCP servers. After any Gemini-managed MCP settings change, inspect the raw file with `discord-mcp doctor --client gemini-cli --profile <name>` before restarting; do not use a managed rewrite as a substitute for this generated fragment.';

function renderGeminiMcpServersJson(cfg: SnippetConfig): string {
  const token =
    cfg.discordToken === undefined || cfg.discordToken === LEGACY_TOKEN_PLACEHOLDER
      ? GEMINI_TOKEN_PLACEHOLDER
      : cfg.discordToken;
  return renderMcpServersJson({ ...cfg, discordToken: token });
}

export const geminiCliGenerator: ClientGenerator = {
  id: 'gemini-cli',
  displayName: 'Gemini CLI',
  generate(cfg: SnippetConfig): Snippet {
    return {
      format: 'json',
      content: renderGeminiMcpServersJson(cfg),
      configFilePath: CONFIG_PATH,
      instructions: INSTRUCTIONS,
    };
  },
};
