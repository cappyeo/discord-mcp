import { afterEach, describe, expect, it, vi } from 'vitest';
import { isScalar, parseDocument } from 'yaml';
import { deepseekHarnessGenerator } from './deepseek-harness.js';

// Preserve the Cordis expression as data; tests must never evaluate YAML code.
function parsePatch(content: string) {
  const document = parseDocument(content, {
    customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }],
  });
  expect(document.errors).toEqual([]);
  expect(document.warnings).toEqual([]);
  return document;
}

afterEach(() => vi.unstubAllEnvs());

describe('deepseekHarnessGenerator', () => {
  it('emits a Cordis insert patch for the official stdio MCP plugin', () => {
    const snippet = deepseekHarnessGenerator.generate({
      serverPath: 'npx',
      serverArgs: ['--yes', '@discord-mcp/cli', 'serve', '--profile', 'devbot'],
    });
    expect(snippet.format).toBe('yaml');
    expect(parsePatch(snippet.content).toJS()).toEqual([
      {
        insert: [
          {
            id: 'mcp-discord-mcp',
            name: '@deepseek-ai/dsh-mcp-client',
            config: {
              serverName: 'discord-mcp',
              transport: 'stdio',
              command: 'npx',
              args: ['--yes', '@discord-mcp/cli', 'serve', '--profile', 'devbot'],
              toolCallTimeoutMs: 180000,
              failOnStartupError: true,
              env: { DISCORD_TOKEN: 'process.env.DISCORD_TOKEN' },
            },
          },
        ],
      },
    ]);
    expect(snippet.content.endsWith('\n')).toBe(true);
    expect(snippet.configFilePath).toContain('$DSH_HOME/profiles/<name>/cordis.patch.yml');
    expect(snippet.instructions).toContain('dsh web --patch <path>');
  });

  it.each([
    undefined,
    // biome-ignore lint/suspicious/noTemplateCurlyInString: legacy init placeholder
    '${env:DISCORD_TOKEN}',
  ])('forwards the token with a YAML expression for input %s', (discordToken) => {
    vi.stubEnv('DISCORD_TOKEN', 'ambient-discord-secret');
    vi.stubEnv('DEEPSEEK_API_KEY', 'ambient-deepseek-secret');
    const snippet = deepseekHarnessGenerator.generate({
      serverPath: 'node',
      ...(discordToken === undefined ? {} : { discordToken }),
    });
    const token = parsePatch(snippet.content).getIn(
      [0, 'insert', 0, 'config', 'env', 'DISCORD_TOKEN'],
      true,
    );
    expect(isScalar(token)).toBe(true);
    if (!isScalar(token)) throw new Error('Expected a tagged YAML scalar');
    expect(token.tag).toBe('tag:yaml.org,2002:js');
    expect(token.value).toBe('process.env.DISCORD_TOKEN');
    expect(snippet.content).not.toContain('ambient-');
    expect(snippet.content).not.toContain('DEEPSEEK_API_KEY');
  });

  it('round-trips Windows paths, gateway args, and policy values without YAML injection', () => {
    const serverPath = 'C:\\Program Files\\Node.js\\node.exe';
    const serverArgs = ['C:\\Users\\Nguyễn\\discord-mcp\\cli.js', 'line\n"quoted" # argument'];
    const envVars = {
      ALLOWED_GUILDS: '111122223333444455',
      MCP_TOOL_SURFACE: 'progressive',
      MCP_WRITE_MODE: 'preview',
      MCP_CATEGORIES: 'messages,guild',
      'key: # name': '!!js process.exit()\n- insert: []',
    };
    const explicitToken = 'Bot "explicit"\n!!js process.exit()';
    const snippet = deepseekHarnessGenerator.generate({
      serverPath,
      serverArgs,
      gateway: true,
      discordToken: explicitToken,
      envVars,
    });
    const document = parsePatch(snippet.content);
    expect(document.toJS()[0].insert[0].config).toMatchObject({
      command: serverPath,
      args: [...serverArgs, '--gateway'],
      env: { ...envVars, DISCORD_TOKEN: explicitToken },
    });
    const token = document.getIn([0, 'insert', 0, 'config', 'env', 'DISCORD_TOKEN'], true);
    expect(isScalar(token) && token.tag === undefined).toBe(true);
    expect(serverArgs).toHaveLength(2);
  });
});
