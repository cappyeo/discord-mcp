import { describe, expect, it } from 'vitest';
import { codexGenerator } from './codex.js';
import type { SnippetConfig } from './types.js';

const baseConfig: SnippetConfig = {
  serverPath: 'node',
  serverArgs: ['/opt/discord-mcp/cli.js'],
  // biome-ignore lint/suspicious/noTemplateCurlyInString: literal placeholder passed by init
  discordToken: '${env:DISCORD_TOKEN}',
};

describe('codexGenerator', () => {
  it('generates a TOML fragment that forwards the token from the environment', () => {
    const snippet = codexGenerator.generate(baseConfig);

    expect(snippet.format).toBe('toml');
    expect(snippet.content).toContain('[mcp_servers.discord-mcp]');
    expect(snippet.content).toContain('command = "node"');
    expect(snippet.content).toContain('args = ["/opt/discord-mcp/cli.js"]');
    expect(snippet.content).toContain('env_vars = ["DISCORD_TOKEN"]');
    expect(snippet.content).not.toContain('[mcp_servers.discord-mcp.env]');
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal placeholder must not reach Codex TOML
    expect(snippet.content).not.toContain('${env:DISCORD_TOKEN}');
  });

  it('adds gateway mode to the server arguments', () => {
    const snippet = codexGenerator.generate({ ...baseConfig, gateway: true });

    expect(snippet.content).toContain('args = ["/opt/discord-mcp/cli.js", "--gateway"]');
  });

  it('adds progressive discovery without persisting the forwarded token', () => {
    const snippet = codexGenerator.generate({
      ...baseConfig,
      envVars: { MCP_TOOL_SURFACE: 'progressive' },
    });

    expect(snippet.content).toContain('env_vars = ["DISCORD_TOKEN"]');
    expect(snippet.content).toContain('[mcp_servers.discord-mcp.env]');
    expect(snippet.content).toContain('MCP_TOOL_SURFACE = "progressive"');
    expect(snippet.content).not.toContain('DISCORD_TOKEN =');
  });

  it('writes an explicit token only when the user provided one', () => {
    const snippet = codexGenerator.generate({ ...baseConfig, discordToken: 'Bot abc123' });

    expect(snippet.content).not.toContain('env_vars');
    expect(snippet.content).toContain('[mcp_servers.discord-mcp.env]');
    expect(snippet.content).toContain('DISCORD_TOKEN = "Bot abc123"');
  });

  it('documents Codex config and environment forwarding', () => {
    const snippet = codexGenerator.generate(baseConfig);

    expect(snippet.configFilePath).toContain('.codex/config.toml');
    expect(snippet.instructions).toContain('DISCORD_TOKEN');
  });
});
