/**
 * Claude Desktop MCP server snippet generator.
 *
 * Claude Desktop reads `mcpServers` from a JSON file. The path differs
 * by OS; we document all three so users on any platform can find it.
 *
 * Restart Claude Desktop after editing - the file is read once at app
 * startup and not watched.
 */
import { renderMcpServersJson } from './_shared.js';
import type { ClientGenerator, Snippet, SnippetConfig } from './types.js';

const CONFIG_PATH = [
  'macOS:   ~/Library/Application Support/Claude/claude_desktop_config.json',
  'Windows: %APPDATA%\\Claude\\claude_desktop_config.json',
  'Linux:   ~/.config/Claude/claude_desktop_config.json',
].join('\n');

const INSTRUCTIONS =
  'Merge into your existing `mcpServers` object in claude_desktop_config.json (paths above), then fully restart Claude Desktop.';

export const claudeDesktopGenerator: ClientGenerator = {
  id: 'claude-desktop',
  displayName: 'Claude Desktop',
  generate(cfg: SnippetConfig): Snippet {
    return {
      format: 'json',
      content: renderMcpServersJson(cfg),
      configFilePath: CONFIG_PATH,
      instructions: INSTRUCTIONS,
    };
  },
};
