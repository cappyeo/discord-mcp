/** DeepSeek Harness uses Cordis YAML patches and explicit secret forwarding. */
import type { ClientGenerator, Snippet, SnippetConfig } from './types.js';

// biome-ignore lint/suspicious/noTemplateCurlyInString: literal legacy placeholder
const LEGACY_TOKEN_PLACEHOLDER = '${env:DISCORD_TOKEN}';
const CONFIG_PATH = [
  'Profile-level: $DSH_HOME/profiles/<name>/cordis.patch.yml',
  'All profiles:  $DSH_HOME/cordis.patch.yml',
  'Or a separate YAML file passed to dsh web --patch <path>',
].join('\n');
const INSTRUCTIONS =
  'Save this YAML patch as a separate file and launch `dsh web --patch <path>` with DISCORD_TOKEN set, or merge its insert entry into an existing cordis.patch.yml without replacing other patches. Use only one discord-mcp entry in the active patch stack. The official @deepseek-ai/dsh-mcp-client plugin scrubs ambient secrets, so keep the !!js process.env.DISCORD_TOKEN reference to forward the token without storing its value. Run `discord-mcp doctor --profile <name> --online`, then verify tool discovery in Harness; doctor does not inspect Harness YAML.';

function renderPatch(cfg: SnippetConfig): string {
  const args = [...(cfg.serverArgs ?? [])];
  if (cfg.gateway === true) args.push('--gateway');
  const env = {
    ...(cfg.discordToken === undefined ? {} : { DISCORD_TOKEN: cfg.discordToken }),
    ...cfg.envVars,
  };
  const token = env.DISCORD_TOKEN;
  const lines = [
    '- insert:',
    '    - id: mcp-discord-mcp',
    '      name: "@deepseek-ai/dsh-mcp-client"',
    '      config:',
    '        serverName: discord-mcp',
    '        transport: stdio',
    `        command: ${JSON.stringify(cfg.serverPath)}`,
    `        args: ${JSON.stringify(args)}`,
    '        toolCallTimeoutMs: 180000',
    '        failOnStartupError: true',
    '        env:',
    `          DISCORD_TOKEN: ${
      token === undefined || token === LEGACY_TOKEN_PLACEHOLDER
        ? '!!js process.env.DISCORD_TOKEN'
        : JSON.stringify(token)
    }`,
  ];
  for (const [name, value] of Object.entries(env)) {
    if (name !== 'DISCORD_TOKEN') {
      lines.push(`          ${JSON.stringify(name)}: ${JSON.stringify(value)}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

export const deepseekHarnessGenerator: ClientGenerator = {
  id: 'deepseek-harness',
  displayName: 'DeepSeek Harness',
  generate(cfg: SnippetConfig): Snippet {
    return {
      format: 'yaml',
      content: renderPatch(cfg),
      configFilePath: CONFIG_PATH,
      instructions: INSTRUCTIONS,
    };
  },
};
