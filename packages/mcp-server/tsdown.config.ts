import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/cli.ts'],
  format: 'esm',
  target: 'node20',
  outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
  dts: false,
  sourcemap: true,
  clean: true,
  deps: {
    neverBundle: ['@discord-mcp/core', '@modelcontextprotocol/sdk', '@discordjs/rest'],
  },
});
