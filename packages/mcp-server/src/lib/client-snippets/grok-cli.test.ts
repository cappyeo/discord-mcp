import { describe, expect, it } from 'vitest';
import { grokCliGenerator } from './grok-cli.js';

describe('grokCliGenerator', () => {
  it('emits a secret-free Grok Build config.toml fragment', () => {
    const snippet = grokCliGenerator.generate({
      serverPath: 'npx',
      serverArgs: ['--yes', '@discord-mcp/cli'],
      discordToken: 'should-not-appear',
      envVars: {
        DISCORD_TOKEN: 'should-not-appear',
        XAI_API_KEY: 'should-not-appear',
        MCP_TOOL_SURFACE: 'progressive',
      },
    });
    expect(snippet).toMatchObject({
      format: 'toml',
      configFilePath: 'User-level: ~/.grok/config.toml',
    });
    expect(snippet.content).toContain('[mcp_servers.discord-mcp]');
    expect(snippet.content).toContain('command = "npx"');
    expect(snippet.content).toContain('args = ["--yes", "@discord-mcp/cli"]');
    expect(snippet.content).toContain('tool_timeout_sec = 180');
    expect(snippet.content).toContain('[mcp_servers.discord-mcp.env]');
    expect(snippet.content).toContain('MCP_TOOL_SURFACE = "progressive"');
    expect(snippet.content).not.toContain('should-not-appear');
    expect(snippet.content).not.toMatch(/DISCORD_TOKEN|XAI_API_KEY/u);
    expect(snippet.instructions).toContain('grok login');
  });
});
