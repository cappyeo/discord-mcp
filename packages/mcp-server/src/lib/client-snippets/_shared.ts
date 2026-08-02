/**
 * Internal shared rendering for MCP client snippets.
 *
 * The JSON-configured clients (Claude Desktop, Claude Code, Cursor, and
 * Generic) converge on the same `mcpServers.<id>.{command,args,env}` schema.
 * Codex has its own TOML renderer because its config supports secure
 * environment forwarding through `env_vars`.
 */
import type { SnippetConfig } from './types.js';

/**
 * Build the `{ command, args, env }` payload for a single MCP server
 * entry. Args are merged: caller-provided `serverArgs` first, then
 * `--gateway` appended when `cfg.gateway === true`. Env includes
 * `DISCORD_TOKEN` when supplied and merges any extra `cfg.envVars`.
 */
function renderServerEntry(cfg: SnippetConfig): {
  command: string;
  args: string[];
  env?: Record<string, string>;
} {
  const args = [...(cfg.serverArgs ?? [])];
  if (cfg.gateway === true) {
    args.push('--gateway');
  }

  const env: Record<string, string> = {
    ...(cfg.discordToken === undefined ? {} : { DISCORD_TOKEN: cfg.discordToken }),
    ...(cfg.envVars ?? {}),
  };

  return {
    command: cfg.serverPath,
    args,
    ...(Object.keys(env).length === 0 ? {} : { env }),
  };
}

/**
 * Render the full top-level JSON document with a single `discord-mcp`
 * server registered under `mcpServers`.
 *
 * The output is pretty-printed with 2-space indent (matches Anthropic's
 * sample configs) and trailing newline.
 */
export function renderMcpServersJson(cfg: SnippetConfig): string {
  const doc = {
    mcpServers: {
      'discord-mcp': renderServerEntry(cfg),
    },
  };
  return `${JSON.stringify(doc, null, 2)}\n`;
}
