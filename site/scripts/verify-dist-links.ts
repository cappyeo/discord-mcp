import { readdir, readFile } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type DefaultTreeAdapterMap, parse } from 'parse5';
import { siteBasePath, siteOrigin } from '../src/seo.js';

type HtmlElement = DefaultTreeAdapterMap['element'];
type HtmlNode = DefaultTreeAdapterMap['node'];

interface VerifyDistLinksOptions {
  basePath: string;
  siteOrigin: string;
}

interface LinkReference {
  attribute: string;
  line: number;
  sourceFile: string;
  value: string;
}

interface ParsedHtmlFile {
  anchors: Set<string>;
  baseHref?: string;
  references: LinkReference[];
  relativePath: string;
  routePath: string;
}

interface LinkIssue extends LinkReference {
  reason: string;
}

export interface DistLinkSummary {
  fragmentReferenceCount: number;
  htmlFileCount: number;
  internalReferenceCount: number;
}

const URL_ATTRIBUTES = new Set(['href', 'poster', 'src']);
const MAX_REPORTED_ISSUES = 50;

function toPosixPath(path: string): string {
  return path.split(sep).join('/');
}

function normalizeBasePath(basePath: string): string {
  if (!basePath.startsWith('/') || basePath.includes('?') || basePath.includes('#')) {
    throw new Error(`deployment base must be an absolute URL path: ${JSON.stringify(basePath)}`);
  }
  return basePath === '/' ? '' : basePath.replace(/\/+$/, '');
}

async function listFiles(root: string): Promise<string[]> {
  const files: string[] = [];

  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((first, second) => first.name.localeCompare(second.name));
    for (const entry of entries) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) files.push(toPosixPath(relative(root, path)));
    }
  };

  await visit(root);
  return files;
}

function routePathForHtml(relativePath: string, basePath: string): string {
  if (relativePath === 'index.html') return `${basePath}/`;
  if (relativePath === '404.html') return `${basePath}/404/`;
  if (relativePath.endsWith('/index.html')) {
    return `${basePath}/${relativePath.slice(0, -'index.html'.length)}`;
  }
  return `${basePath}/${relativePath}`;
}

function isElement(node: HtmlNode): node is HtmlElement {
  return 'tagName' in node && 'attrs' in node;
}

function walkHtml(node: HtmlNode, visit: (element: HtmlElement) => void): void {
  if (isElement(node)) visit(node);
  if ('childNodes' in node) {
    for (const child of node.childNodes) walkHtml(child, visit);
  }
}

function metaRefreshTarget(content: string): string | undefined {
  const match = content.match(/^\s*(?:\d+(?:\.\d*)?|\.\d+)\s*;\s*url\s*=\s*(.*?)\s*$/i);
  if (!match) return undefined;

  const target = match[1];
  const quote = target[0];
  return (quote === '"' || quote === "'") && target.endsWith(quote) ? target.slice(1, -1) : target;
}

async function parseHtmlFile(
  root: string,
  relativePath: string,
  basePath: string,
): Promise<ParsedHtmlFile> {
  const html = await readFile(resolve(root, ...relativePath.split('/')), 'utf8');
  const document = parse(html, { sourceCodeLocationInfo: true });
  const anchors = new Set<string>();
  const references: LinkReference[] = [];
  let baseHref: string | undefined;

  walkHtml(document, (element) => {
    const attributes = new Map(element.attrs.map((attribute) => [attribute.name, attribute.value]));
    const id = attributes.get('id');
    if (id) anchors.add(id);
    const legacyName = element.tagName === 'a' ? attributes.get('name') : undefined;
    if (legacyName) anchors.add(legacyName);

    if (element.tagName === 'base' && baseHref === undefined) {
      baseHref = attributes.get('href');
      return;
    }

    if (
      element.tagName === 'meta' &&
      attributes.get('http-equiv')?.trim().toLowerCase() === 'refresh'
    ) {
      const content = attributes.get('content');
      const target = content === undefined ? undefined : metaRefreshTarget(content);
      if (target !== undefined) {
        const location = element.sourceCodeLocation?.attrs?.content;
        references.push({
          attribute: 'content',
          line: location?.startLine ?? element.sourceCodeLocation?.startLine ?? 1,
          sourceFile: relativePath,
          value: target,
        });
      }
    }

    for (const attribute of element.attrs) {
      if (!URL_ATTRIBUTES.has(attribute.name)) continue;
      const location = element.sourceCodeLocation?.attrs?.[attribute.name];
      references.push({
        attribute: attribute.name,
        line: location?.startLine ?? element.sourceCodeLocation?.startLine ?? 1,
        sourceFile: relativePath,
        value: attribute.value,
      });
    }
  });

  return {
    anchors,
    baseHref,
    references,
    relativePath,
    routePath: routePathForHtml(relativePath, basePath),
  };
}

function internalRelativePath(pathname: string, basePath: string): string | undefined {
  if (pathname === basePath || pathname === `${basePath}/`) return '';
  const prefix = `${basePath}/`;
  return pathname.startsWith(prefix) ? pathname.slice(prefix.length) : undefined;
}

function resolveExistingFile(relativePath: string, files: Set<string>): string | undefined {
  if (!relativePath) return files.has('index.html') ? 'index.html' : undefined;
  if (relativePath === '404/' && files.has('404.html')) return '404.html';

  const candidates = relativePath.endsWith('/')
    ? [`${relativePath}index.html`]
    : [relativePath, `${relativePath}.html`, `${relativePath}/index.html`];
  return candidates.find((candidate) => files.has(candidate));
}

function decodedComponent(value: string, description: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new Error(`malformed percent-encoding in ${description} ${JSON.stringify(value)}`);
  }
}

function issue(reference: LinkReference, reason: string): LinkIssue {
  return { ...reference, reason };
}

function formatIssues(issues: LinkIssue[]): string {
  issues.sort(
    (first, second) =>
      first.sourceFile.localeCompare(second.sourceFile) ||
      first.line - second.line ||
      first.attribute.localeCompare(second.attribute) ||
      first.value.localeCompare(second.value) ||
      first.reason.localeCompare(second.reason),
  );
  const visible = issues
    .slice(0, MAX_REPORTED_ISSUES)
    .map(
      (entry) =>
        `- ${entry.sourceFile}:${entry.line} ${entry.attribute}=${JSON.stringify(entry.value)}: ${entry.reason}`,
    );
  if (issues.length > visible.length) visible.push(`- ... ${issues.length - visible.length} more`);
  return `[verify-dist-links] found ${issues.length} broken internal references\n${visible.join('\n')}`;
}

export async function verifyDistLinks(
  distRoot: string,
  options: VerifyDistLinksOptions,
): Promise<DistLinkSummary> {
  const root = resolve(distRoot);
  const basePath = normalizeBasePath(options.basePath);
  const origin = new URL(options.siteOrigin).origin;
  const relativeFiles = await listFiles(root);
  const files = new Set(relativeFiles);
  const htmlPaths = relativeFiles.filter((path) => path.endsWith('.html'));
  const htmlFiles = await Promise.all(htmlPaths.map((path) => parseHtmlFile(root, path, basePath)));
  const htmlByPath = new Map(htmlFiles.map((file) => [file.relativePath, file]));
  const issues: LinkIssue[] = [];
  let fragmentReferenceCount = 0;
  let internalReferenceCount = 0;

  for (const source of htmlFiles) {
    const documentUrl = new URL(source.routePath, origin);
    let resolutionBase = documentUrl;
    if (source.baseHref !== undefined) {
      try {
        resolutionBase = new URL(source.baseHref, documentUrl);
      } catch {
        issues.push(
          issue(
            {
              attribute: 'href',
              line: 1,
              sourceFile: source.relativePath,
              value: source.baseHref,
            },
            'invalid base URL',
          ),
        );
      }
    }

    for (const reference of source.references) {
      let targetUrl: URL;
      try {
        targetUrl = new URL(reference.value, resolutionBase);
      } catch {
        issues.push(issue(reference, 'invalid URL'));
        continue;
      }
      if (targetUrl.origin !== origin) continue;
      internalReferenceCount += 1;

      const encodedRelativePath = internalRelativePath(targetUrl.pathname, basePath);
      if (encodedRelativePath === undefined) {
        issues.push(
          issue(
            reference,
            `outside deployment base ${targetUrl.pathname} (expected ${basePath || '/'})`,
          ),
        );
        continue;
      }

      let relativePath: string;
      try {
        relativePath = decodedComponent(encodedRelativePath, 'path');
      } catch (error) {
        issues.push(issue(reference, error instanceof Error ? error.message : String(error)));
        continue;
      }
      const targetFile = resolveExistingFile(relativePath, files);
      if (!targetFile) {
        issues.push(issue(reference, `missing internal target ${targetUrl.pathname}`));
        continue;
      }

      const encodedFragment = targetUrl.hash.slice(1);
      if (!encodedFragment) continue;
      const targetHtml = htmlByPath.get(targetFile);
      if (!targetHtml) continue;

      let fragment: string;
      try {
        fragment = decodedComponent(encodedFragment, 'fragment');
      } catch (error) {
        issues.push(issue(reference, error instanceof Error ? error.message : String(error)));
        continue;
      }
      const directiveIndex = fragment.indexOf(':~:');
      if (directiveIndex >= 0) fragment = fragment.slice(0, directiveIndex);
      if (!fragment) continue;
      fragmentReferenceCount += 1;
      if (!targetHtml.anchors.has(fragment)) {
        issues.push(issue(reference, `missing fragment #${fragment} in ${targetUrl.pathname}`));
      }
    }
  }

  if (issues.length > 0) throw new Error(formatIssues(issues));
  return {
    fragmentReferenceCount,
    htmlFileCount: htmlFiles.length,
    internalReferenceCount,
  };
}

async function main(): Promise<void> {
  const distRoot = fileURLToPath(new URL('../dist/', import.meta.url));
  const summary = await verifyDistLinks(distRoot, { basePath: siteBasePath, siteOrigin });
  console.log(`[verify-dist-links] scanned ${summary.htmlFileCount} HTML files`);
  console.log(
    `[verify-dist-links] verified ${summary.internalReferenceCount} internal references and ${summary.fragmentReferenceCount} fragments`,
  );
  console.log('[verify-dist-links] passed');
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
