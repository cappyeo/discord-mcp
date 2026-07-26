/**
 * Fails if a packed tarball still carries a `workspace:` dependency range.
 *
 * pnpm rewrites `workspace:*` to a real version on pack; npm does not. A
 * published manifest containing `"@discord-mcp/core": "workspace:*"` breaks
 * every consumer install with `Unsupported URL Type "workspace:"` and cannot
 * be fixed without a deprecate + republish. So we assert against the actual
 * tarball rather than trusting whichever tool happened to build it.
 *
 * Scoped to `dependencies` on purpose: the private `@discord-mcp/server-mocks`
 * devDependency is harmless in a tarball and would false-positive.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const packages = ['packages/mcp-core', 'packages/mcp-server'];
// Windows resolves pnpm through a .cmd shim, which Node refuses to spawn directly.
const shell = process.platform === 'win32';
let failed = false;

for (const dir of packages) {
  const dest = mkdtempSync(join(tmpdir(), 'packcheck-'));
  execFileSync('pnpm', ['pack', '--pack-destination', shell ? `"${dest}"` : dest], {
    cwd: dir,
    stdio: 'inherit',
    shell,
  });
  // Run tar from inside `dest` with a bare filename: an absolute Windows path
  // like `C:\...` would be read as a remote host by GNU tar.
  const raw = execFileSync('tar', ['-xzOf', readdirSync(dest)[0], 'package/package.json'], {
    cwd: dest,
    encoding: 'utf8',
  });
  const manifest = JSON.parse(raw);
  const deps = JSON.stringify(manifest.dependencies ?? {});
  if (deps.includes('workspace:')) {
    console.error(`FAIL ${manifest.name}: workspace: protocol in packed dependencies -> ${deps}`);
    failed = true;
  } else {
    process.stdout.write(`ok ${manifest.name}\n`);
  }
}

process.exit(failed ? 1 : 0);
