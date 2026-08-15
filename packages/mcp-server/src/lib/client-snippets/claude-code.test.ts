import { describe, expect, it } from 'vitest';
import { claudeCodeGenerator } from './claude-code.js';
import type { SnippetConfig } from './types.js';

const baseConfig: SnippetConfig = {
  serverPath: 'npx',
  serverArgs: ['@discord-mcp/cli'],
  // biome-ignore lint/suspicious/noTemplateCurlyInString: this IS the literal placeholder syntax used by MCP clients
  discordToken: '${env:DISCORD_TOKEN}',
};

interface ParsedDoc {
  mcpServers: {
    'discord-mcp': {
      command: string;
      args: string[];
      env?: Record<string, string>;
    };
  };
}

function parseSnippet(content: string): ParsedDoc {
  return JSON.parse(content) as ParsedDoc;
}

describe('claudeCodeGenerator', () => {
  it('exposes id and displayName', () => {
    expect(claudeCodeGenerator.id).toBe('claude-code');
    expect(claudeCodeGenerator.displayName).toBe('Claude Code');
  });

  it('generates parseable JSON with same shape as Claude Desktop', () => {
    const snippet = claudeCodeGenerator.generate(baseConfig);
    expect(snippet.format).toBe('json');
    const parsed = parseSnippet(snippet.content);
    expect(parsed.mcpServers).toBeDefined();
    expect(parsed.mcpServers['discord-mcp']).toBeDefined();
  });

  it('uses Claude Code environment interpolation for the legacy placeholder', () => {
    const snippet = claudeCodeGenerator.generate(baseConfig);
    const env = parseSnippet(snippet.content).mcpServers['discord-mcp'].env;
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal placeholder, not JS interpolation
    expect(env?.DISCORD_TOKEN).toBe('${DISCORD_TOKEN}');
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal legacy placeholder, not JS interpolation
    expect(snippet.content).not.toContain('${env:DISCORD_TOKEN}');
  });

  it('keeps guided profile setup secret-free when no token is supplied', () => {
    const { discordToken: _omitted, ...withoutToken } = baseConfig;
    const snippet = claudeCodeGenerator.generate(withoutToken);
    expect(parseSnippet(snippet.content).mcpServers['discord-mcp'].env).toBeUndefined();
  });

  it('handles npx-style serverPath/args', () => {
    const snippet = claudeCodeGenerator.generate(baseConfig);
    const parsed = parseSnippet(snippet.content);
    expect(parsed.mcpServers['discord-mcp'].command).toBe('npx');
    expect(parsed.mcpServers['discord-mcp'].args).toEqual(['@discord-mcp/cli']);
  });

  it('appends --gateway to args when gateway: true', () => {
    const snippet = claudeCodeGenerator.generate({ ...baseConfig, gateway: true });
    const args = parseSnippet(snippet.content).mcpServers['discord-mcp'].args;
    expect(args).toEqual(['@discord-mcp/cli', '--gateway']);
  });

  it('configFilePath is non-empty and mentions ~/.claude.json', () => {
    const snippet = claudeCodeGenerator.generate(baseConfig);
    expect(snippet.configFilePath.length).toBeGreaterThan(0);
    expect(snippet.configFilePath).toContain('.claude.json');
  });

  it('instructions reference `claude mcp add`', () => {
    const snippet = claudeCodeGenerator.generate(baseConfig);
    expect(snippet.instructions).toContain('claude mcp add');
  });
});
