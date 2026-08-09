import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { verifyDistLinks } from './verify-dist-links.js';

const fixtureRoots: string[] = [];
const options = {
  basePath: '/discord-mcp',
  siteOrigin: 'https://cappyeo.github.io',
};

async function createFixture(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'discord-mcp-links-'));
  fixtureRoots.push(root);

  for (const [relativePath, content] of Object.entries(files)) {
    const file = join(root, relativePath);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, content);
  }

  return root;
}

afterEach(async () => {
  await Promise.all(
    fixtureRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe('generated site link verification', () => {
  it('accepts existing routes, assets, encoded fragments, and same-origin absolute links', async () => {
    const root = await createFixture({
      'index.html': `<!doctype html><html><head>
        <link rel="stylesheet" href="/discord-mcp/assets/site.css">
        </head><body id="_top">
        <a href="/discord-mcp/guide/?mode=full&amp;from=home#target%20section">Guide</a>
        <a href="https://cappyeo.github.io/discord-mcp/guide/#legacy">Legacy</a>
        <a href="/discord-mcp/guide/#target%20section:~:text=Guide">Text fragment</a>
        <a href="guide">Relative route</a>
        <a href="#">Top</a>
        <a href="mailto:docs@example.com">Email</a>
        <img src="/discord-mcp/assets/logo.svg">
        <video poster="/discord-mcp/assets/poster.webp"></video>
        </body></html>`,
      'guide/index.html': `<!doctype html><html><body>
        <h1 id="target section">Guide</h1><a name="legacy">Legacy target</a>
        </body></html>`,
      'architecture/overview/index.html': `<!doctype html><html><body>
        <meta http-equiv="refresh" content="0;url=/discord-mcp/guide/">
        <a href="/discord-mcp/guide/">Continue</a>
        </body></html>`,
      'assets/site.css': 'body {}',
      'assets/logo.svg': '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
      'assets/poster.webp': 'fixture',
    });

    await expect(verifyDistLinks(root, options)).resolves.toEqual({
      fragmentReferenceCount: 3,
      htmlFileCount: 3,
      internalReferenceCount: 10,
    });
  });

  it('reports missing routes, assets, and fragments together', async () => {
    const root = await createFixture({
      'index.html': `<!doctype html><html><body>
        <a href="/discord-mcp/missing/">Missing route</a>
        <a href="/discord-mcp/guide/#absent">Missing fragment</a>
        <img src="/discord-mcp/assets/missing.png">
        </body></html>`,
      'guide/index.html': '<!doctype html><html><body><h1 id="present">Guide</h1></body></html>',
    });

    await expect(verifyDistLinks(root, options)).rejects.toThrow(
      /missing internal target.*missing fragment.*missing internal target/s,
    );
  });

  it('uses case-sensitive paths and rejects same-origin links outside the deployment base', async () => {
    const root = await createFixture({
      'index.html': `<!doctype html><html><body>
        <a href="/discord-mcp/guide/">Wrong case</a>
        <a href="/start/">Outside base</a>
        </body></html>`,
      'Guide/index.html': '<!doctype html><html><body><h1>Guide</h1></body></html>',
    });

    await expect(verifyDistLinks(root, options)).rejects.toThrow(
      /missing internal target.*outside deployment base/s,
    );
  });

  it('models the GitHub Pages 404 fallback route explicitly', async () => {
    const root = await createFixture({
      '404.html': `<!doctype html><html><head>
        <link rel="canonical" href="https://cappyeo.github.io/discord-mcp/404/">
        </head><body><h1 id="_top">Not found</h1></body></html>`,
    });

    await expect(verifyDistLinks(root, options)).resolves.toEqual({
      fragmentReferenceCount: 0,
      htmlFileCount: 1,
      internalReferenceCount: 1,
    });
  });

  it('rejects a missing meta refresh target', async () => {
    const root = await createFixture({
      'index.html': `<!doctype html><html><head>
        <meta http-equiv="refresh" content="0; URL='/discord-mcp/missing/'">
        </head><body><h1>Redirecting</h1></body></html>`,
    });

    await expect(verifyDistLinks(root, options)).rejects.toThrow(
      /content="\/discord-mcp\/missing\/": missing internal target/,
    );
  });

  it('does not treat inert template content as a document fragment target', async () => {
    const root = await createFixture({
      'index.html': `<!doctype html><html><body>
        <a href="#template-only">Inactive target</a>
        <template><span id="template-only">Not in the document tree</span></template>
        </body></html>`,
    });

    await expect(verifyDistLinks(root, options)).rejects.toThrow(/missing fragment #template-only/);
  });
});
