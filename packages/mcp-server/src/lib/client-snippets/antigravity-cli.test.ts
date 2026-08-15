import { describe, expect, it } from 'vitest';
import { antigravityCliGenerator } from './antigravity-cli.js';

const baseConfig = {
  serverPath: 'npx',
  serverArgs: [
    '--yes',
    '--loglevel=error',
    '@discord-mcp/cli@0.23.0',
    'serve',
    '--profile',
    'devbot',
  ],
};

describe('antigravityCliGenerator', () => {
  it('emits the dedicated Antigravity MCP shape without persisting a token', () => {
    const snippet = antigravityCliGenerator.generate(baseConfig);
    const parsed = JSON.parse(snippet.content);

    expect(antigravityCliGenerator.id).toBe('antigravity-cli');
    expect(antigravityCliGenerator.displayName).toBe('Antigravity CLI');
    expect(parsed).toEqual({
      mcpServers: {
        'discord-mcp': {
          command: 'npx',
          args: baseConfig.serverArgs,
        },
      },
    });
    expect(snippet.content).not.toContain('DISCORD_TOKEN');
    expect(snippet.configFilePath).toContain('.gemini/config/mcp_config.json');
    expect(snippet.configFilePath).toContain('.agents/mcp_config.json');
  });

  it('drops a supplied literal token instead of writing it to Antigravity config', () => {
    const secret = `Bot ${'s'.repeat(60)}`;
    const snippet = antigravityCliGenerator.generate({
      ...baseConfig,
      discordToken: secret,
      envVars: { discord_token: secret, MCP_TOOL_SURFACE: 'progressive' },
    });

    expect(snippet.content).not.toContain(secret);
    expect(snippet.content.toUpperCase()).not.toContain('DISCORD_TOKEN');
    expect(JSON.parse(snippet.content).mcpServers['discord-mcp'].env).toEqual({
      MCP_TOOL_SURFACE: 'progressive',
    });
  });

  it('preserves non-secret environment configuration and gateway arguments', () => {
    const parsed = JSON.parse(
      antigravityCliGenerator.generate({
        ...baseConfig,
        gateway: true,
        envVars: { MCP_TOOL_SURFACE: 'progressive' },
      }).content,
    );

    expect(parsed.mcpServers['discord-mcp']).toMatchObject({
      args: [...baseConfig.serverArgs, '--gateway'],
      env: { MCP_TOOL_SURFACE: 'progressive' },
    });
  });
});
