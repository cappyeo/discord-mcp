/**
 * Exercise the exact catalog image boundary used by MCP registry scanners.
 *
 * The container receives no credential, has no network, runs read-only as a
 * non-root user, and must still expose the complete production tool contract.
 */
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

const repoRoot = resolve(import.meta.dirname, '../..');
const image = process.env.CATALOG_IMAGE ?? 'discord-mcp-catalog:ci';
const requireFromCli = createRequire(join(repoRoot, 'packages/mcp-server/package.json'));
const { Client } = requireFromCli('@modelcontextprotocol/client');
const { StdioClientTransport } = requireFromCli('@modelcontextprotocol/client/stdio');

const imageConfig = JSON.parse(
  execFileSync('docker', ['image', 'inspect', '--format', '{{json .Config}}', image], {
    encoding: 'utf8',
  }),
);

assert.equal(imageConfig.User, 'node');
assert.deepEqual(imageConfig.Entrypoint, ['node', 'dist/cli.js']);
assert.deepEqual(imageConfig.Cmd, ['catalog']);
assert.ok(
  imageConfig.Env.every((entry) => !entry.startsWith('DISCORD_TOKEN=')),
  'catalog image must not contain DISCORD_TOKEN',
);

const transport = new StdioClientTransport({
  command: 'docker',
  args: [
    'run',
    '--rm',
    '-i',
    '--network',
    'none',
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    image,
  ],
  cwd: repoRoot,
  stderr: 'pipe',
});
const client = new Client(
  { name: 'discord-mcp-catalog-container-acceptance', version: '0.0.0' },
  { capabilities: {} },
);

try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  assert.equal(tools.length, 208);
  assert.ok(tools.some((tool) => tool.name === 'guild_blueprint_plan'));
  assert.ok(tools.some((tool) => tool.name === 'messages_send'));

  const { resources } = await client.listResources();
  assert.equal(resources.length, 6);

  for (const request of [
    { name: 'guild_get', arguments: { guild_id: '111122223333444455' } },
    {
      name: 'messages_send',
      arguments: { channel_id: '111122223333444455', content: 'must never execute' },
    },
    { name: 'unknown_catalog_tool', arguments: {} },
  ]) {
    const result = await client.callTool(request);
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent?.code, 'CATALOG_ONLY');
    assert.equal(result.structuredContent?.retriable, false);
    assert.equal(result.structuredContent?.category, 'client');
  }

  process.stdout.write(`ok catalog container: ${tools.length} tools, Discord execution disabled\n`);
} finally {
  await client.close();
}
