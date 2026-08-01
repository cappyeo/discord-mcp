import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const distRoot = new URL('../dist/', import.meta.url);

async function readRoute(route: string): Promise<string> {
  return readFile(new URL(`${route}/index.html`, distRoot), 'utf8');
}

function linkTagFor(html: string, href: string): string {
  const escapedHref = href.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = html.match(new RegExp(`<a[^>]*href="${escapedHref}"[^>]*>`));
  assert(match, `Expected a link to ${href}.`);
  return match[0];
}

const detail = await readRoute('tools/messages/send');
const breadcrumb = detail.match(
  /<nav[^>]*class="[^"]*\btool-breadcrumbs\b[^"]*"[^>]*aria-label="Breadcrumb"[^>]*>.*?<\/nav>/s,
);
assert(breadcrumb, 'Expected a semantic tool breadcrumb.');
assert.match(breadcrumb[0], /<a[^>]*href="\/discord-mcp\/tools\/"[^>]*>\s*Tools<\/a>/);
assert.match(breadcrumb[0], /<a[^>]*href="\/discord-mcp\/tools\/messages\/"[^>]*>\s*Messages<\/a>/);

const detailCategoryLink = linkTagFor(detail, '/discord-mcp/tools/messages/');
assert.match(detailCategoryLink, /aria-current="location"/);
assert.match(detailCategoryLink, /data-current-location="true"/);
assert.match(detail, /<details open[^>]*>\s*<summary[^>]*>.*?<span[^>]*>Messaging<\/span>/s);

const category = await readRoute('tools/messages');
const categoryLink = linkTagFor(category, '/discord-mcp/tools/messages/');
assert.match(categoryLink, /aria-current="page"/);
assert.doesNotMatch(category, /class="tool-breadcrumbs"/);

console.log('[verify-tool-navigation] breadcrumb and sidebar context verified');
