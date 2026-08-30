import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GrokCliConfigError, inspectGrokCliConfig } from './grok-cli-inspector.js';

const profile = {
  version: 1 as const,
  name: 'devbot',
  bot: { id: '1533719084636700773', username: 'devbot' },
  credential: { provider: 'env' as const, variable: 'DISCORD_TOKEN' as const },
  allowedGuilds: ['1537332825978568744'],
  client: 'grok-cli' as const,
  toolSurface: 'progressive' as const,
  gateway: false,
};

const launcher = `[models]\nmodel = "grok-build"\nenv_key = "XAI_API_KEY"\n\n[mcp_servers.discord-mcp]\ncommand = "npx"\nargs = ["--yes", "--loglevel=error", "@discord-mcp/cli@0.25.1", "serve", "--profile", "devbot"]\nenabled = true\nstartup_timeout_sec = 90\ntool_timeout_sec = 180\n`;
const roots: string[] = [];

function fixture(): { path: string; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'grok-inspector-'));
  roots.push(root);
  return { root, path: join(root, 'config.toml') };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('inspectGrokCliConfig', () => {
  it('accepts the exact profile launcher while allowing host auth outside its MCP table', () => {
    const { path } = fixture();
    writeFileSync(path, launcher);
    expect(inspectGrokCliConfig(profile, { config: path })).toMatchObject({
      currentVersion: '0.25.1',
      credentialPersisted: false,
    });
  });

  it('rejects credentials persisted in the discord-mcp table', () => {
    const { path } = fixture();
    writeFileSync(path, `${launcher}\n[mcp_servers.discord-mcp.env]\nDISCORD_TOKEN = "leak"\n`);
    expect(() => inspectGrokCliConfig(profile, { config: path })).toThrowError(GrokCliConfigError);
  });

  it('rejects an ambiguous duplicate discord-mcp table', () => {
    const { path } = fixture();
    writeFileSync(path, `${launcher}\n[mcp_servers.discord-mcp]\ncommand = "other"\n`);
    expect(() => inspectGrokCliConfig(profile, { config: path })).toThrowError(
      /table is duplicated/u,
    );
  });

  it('rejects timeout drift and extra launcher keys', () => {
    const timeout = fixture();
    writeFileSync(
      timeout.path,
      launcher.replace('tool_timeout_sec = 180', 'tool_timeout_sec = 181'),
    );
    expect(() => inspectGrokCliConfig(profile, { config: timeout.path })).toThrowError(
      /selected profile/u,
    );

    const extra = fixture();
    writeFileSync(extra.path, launcher.replace('enabled = true', 'enabled = true\nenv = {}'));
    expect(() => inspectGrokCliConfig(profile, { config: extra.path })).toThrowError(
      /exact generated fragment/u,
    );
  });

  it('honors GROK_HOME for the default config path', () => {
    const { root } = fixture();
    writeFileSync(join(root, 'config.toml'), launcher);
    expect(inspectGrokCliConfig(profile, { environment: { GROK_HOME: root } })).toMatchObject({
      currentVersion: '0.25.1',
    });
  });
});
