import { describe, expect, it } from 'vitest';

import { cursorCliGenerator } from './cursor-cli.js';

const baseConfig = {
  serverPath: 'npx',
  serverArgs: [
    '--yes',
    '--loglevel=error',
    '@discord-mcp/cli@0.25.0',
    'serve',
    '--profile',
    'devbot',
  ],
};

describe('cursorCliGenerator', () => {
  it('emits Cursor MCP config without persisting either caller credential', () => {
    const secret = `Bot ${'s'.repeat(60)}`;
    const snippet = cursorCliGenerator.generate({
      ...baseConfig,
      discordToken: secret,
      envVars: {
        discord_token: secret,
        CURSOR_API_KEY: 'cursor-model-secret',
        MCP_TOOL_SURFACE: 'progressive',
      },
    });
    const parsed = JSON.parse(snippet.content);

    expect(cursorCliGenerator.id).toBe('cursor-cli');
    expect(cursorCliGenerator.displayName).toBe('Cursor Agent CLI');
    expect(parsed).toEqual({
      mcpServers: {
        'discord-mcp': {
          command: 'npx',
          args: baseConfig.serverArgs,
          env: { MCP_TOOL_SURFACE: 'progressive' },
        },
      },
    });
    expect(snippet.content).not.toContain(secret);
    expect(snippet.content).not.toContain('cursor-model-secret');
    expect(snippet.content).not.toMatch(/DISCORD_TOKEN|CURSOR_API_KEY/iu);
  });

  it('documents both Cursor scopes and the inherited credential boundary', () => {
    const snippet = cursorCliGenerator.generate(baseConfig);
    expect(snippet.configFilePath).toContain('~/.cursor/mcp.json');
    expect(snippet.configFilePath).toContain('<project>/.cursor/mcp.json');
    expect(snippet.instructions).toContain('official `agent` command');
    expect(snippet.instructions).toContain('native Windows');
    expect(snippet.instructions).toContain('deny-by-default');
    expect(JSON.parse(snippet.content).mcpServers['discord-mcp'].env).toBeUndefined();
  });
});
