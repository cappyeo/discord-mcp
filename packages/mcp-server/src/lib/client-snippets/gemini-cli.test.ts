import { describe, expect, it } from 'vitest';
import { geminiCliGenerator } from './gemini-cli.js';
import type { SnippetConfig } from './types.js';

const baseConfig: SnippetConfig = {
  serverPath: 'npx',
  serverArgs: ['@discord-mcp/cli'],
  // biome-ignore lint/suspicious/noTemplateCurlyInString: literal legacy placeholder
  discordToken: '${env:DISCORD_TOKEN}',
};

interface ParsedDoc {
  mcpServers: {
    'discord-mcp': {
      command: string;
      args: string[];
      env: Record<string, string>;
    };
  };
}

function parseSnippet(content: string): ParsedDoc {
  return JSON.parse(content) as ParsedDoc;
}

describe('geminiCliGenerator', () => {
  it('exposes the stable client identity', () => {
    expect(geminiCliGenerator.id).toBe('gemini-cli');
    expect(geminiCliGenerator.displayName).toBe('Gemini CLI (enterprise compatibility)');
  });

  it('emits a parseable Gemini settings document', () => {
    const parsed = parseSnippet(geminiCliGenerator.generate(baseConfig).content);

    expect(parsed.mcpServers['discord-mcp']).toMatchObject({
      command: 'npx',
      args: ['@discord-mcp/cli'],
    });
  });

  it('normalizes the legacy token placeholder to Gemini interpolation', () => {
    const content = geminiCliGenerator.generate(baseConfig).content;
    const env = parseSnippet(content).mcpServers['discord-mcp'].env;

    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal Gemini placeholder
    expect(env.DISCORD_TOKEN).toBe('${DISCORD_TOKEN}');
    // biome-ignore lint/suspicious/noTemplateCurlyInString: legacy placeholder must be absent
    expect(content).not.toContain('${env:DISCORD_TOKEN}');
  });

  it('explicitly forwards DISCORD_TOKEN for guided profiles without storing the secret', () => {
    const { discordToken: _omitted, ...withoutToken } = baseConfig;
    const content = geminiCliGenerator.generate(withoutToken).content;
    const env = parseSnippet(content).mcpServers['discord-mcp'].env;

    // Gemini sanitizes inherited sensitive variables unless the MCP entry opts in.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal Gemini placeholder
    expect(env.DISCORD_TOKEN).toBe('${DISCORD_TOKEN}');
  });

  it('preserves an explicitly supplied token for legacy stateless init', () => {
    const env = parseSnippet(
      geminiCliGenerator.generate({ ...baseConfig, discordToken: 'Bot explicit' }).content,
    ).mcpServers['discord-mcp'].env;

    expect(env.DISCORD_TOKEN).toBe('Bot explicit');
  });

  it('keeps server safety environment and gateway arguments', () => {
    const entry = parseSnippet(
      geminiCliGenerator.generate({
        ...baseConfig,
        gateway: true,
        envVars: {
          ALLOWED_GUILDS: '111122223333444455',
          DISCORD_EXPECTED_BOT_ID: '987654321098765432',
        },
      }).content,
    ).mcpServers['discord-mcp'];

    expect(entry.args).toEqual(['@discord-mcp/cli', '--gateway']);
    expect(entry.env).toMatchObject({
      ALLOWED_GUILDS: '111122223333444455',
      DISCORD_EXPECTED_BOT_ID: '987654321098765432',
    });
  });

  it('documents both settings scopes without recommending a secret-materializing CLI rewrite', () => {
    const snippet = geminiCliGenerator.generate(baseConfig);

    expect(snippet.configFilePath).toContain('~/.gemini/settings.json');
    expect(snippet.configFilePath).toContain('<project>/.gemini/settings.json');
    expect(snippet.instructions).toContain('Merge');
    expect(snippet.instructions).not.toContain('gemini mcp add');
    expect(snippet.instructions).toContain('inspect the raw file');
  });
});
