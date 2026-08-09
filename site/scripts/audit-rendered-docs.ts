import { createReadStream, type Stats } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AxeBuilder } from '@axe-core/playwright';
import { type Browser, chromium, type Page } from 'playwright';

const SCRIPT_DIR = fileURLToPath(new URL('.', import.meta.url));
const DIST_DIR = resolve(SCRIPT_DIR, '../dist');
const BASE_PATH = '/discord-mcp';
const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'];
const BLOCKING_INCOMPLETE_IMPACTS = new Set(['critical', 'serious']);
// Axe cannot reliably calculate contrast through every CSS variable, gradient, and syntax token.
// Keep these findings visible for manual review while blocking every other serious/critical result.
const MANUAL_REVIEW_ONLY_INCOMPLETE_RULES = new Set(['color-contrast']);

interface RouteAudit {
  name: string;
  path: string;
  expectedText: string[];
  verify?: (page: Page, viewport: ViewportAudit) => Promise<void>;
}

interface ViewportAudit {
  name: string;
  width: number;
  height: number;
  colorScheme: 'light' | 'dark';
}

const routes: RouteAudit[] = [
  {
    name: 'homepage',
    path: '/',
    expectedText: ['Discord tools for AI clients', 'Start the quickstart', '203 tools'],
  },
  {
    name: 'quickstart',
    path: '/start/quickstart/',
    expectedText: [
      'Run your first Discord tools',
      'mcp_tools_search',
      'mcp_tools_read',
      'mcp_tools_write',
    ],
    verify: async (page, viewport) => {
      if (viewport.width < 800) {
        const summary = page.locator('mobile-tutorial-tracker summary:visible');
        await requireCount(summary, 1, 'mobile tutorial tracker summary');
        await summary.click();
        await requireCount(
          page.locator('nav[aria-label="Tutorial tracker"]:visible'),
          1,
          'open mobile tutorial tracker',
        );
        await summary.press('Escape');
        if (!(await summary.evaluate((element) => element === document.activeElement))) {
          throw new Error('closing the mobile tutorial tracker did not restore summary focus');
        }
        return;
      }
      await requireCount(
        page.locator('nav[aria-label="Tutorial tracker"]:visible'),
        1,
        'visible tutorial tracker',
      );
      const tracker = page.locator('tutorial-unit-tabs:visible');
      const selectedTab = tracker.locator('[role="tab"][aria-selected="true"]');
      await requireCount(selectedTab, 1, 'selected tutorial unit tab');
      const selectedId = await selectedTab.getAttribute('id');
      await selectedTab.press('ArrowRight');
      const nextTab = tracker.locator('[role="tab"][aria-selected="true"]');
      await requireCount(nextTab, 1, 'keyboard-selected tutorial unit tab');
      if ((await nextTab.getAttribute('id')) === selectedId) {
        throw new Error('ArrowRight did not change the selected tutorial unit');
      }
      if (!(await nextTab.evaluate((element) => element === document.activeElement))) {
        throw new Error('keyboard-selected tutorial unit did not receive focus');
      }
      const controlledPanel = await nextTab.getAttribute('aria-controls');
      if (!controlledPanel) throw new Error('selected tutorial unit does not control a panel');
      await requireCount(
        tracker.locator(`#${controlledPanel}:visible`),
        1,
        'keyboard-selected tutorial unit panel',
      );
    },
  },
  {
    name: 'tool-call flow',
    path: '/start/first-tool-call/',
    expectedText: ['How a tool call works', '"tool": "messages_send"', '"args": {'],
    verify: async (page) => {
      const body = await page.locator('body').innerText();
      if (body.includes('"name": "messages_send"')) {
        throw new Error('progressive example regressed to a direct hidden-tool call');
      }
    },
  },
  {
    name: 'tool catalog',
    path: '/tools/messages/',
    expectedText: [
      'Messages',
      'Use the technical identifier shown in each result',
      'messages_send',
    ],
    verify: async (page) => {
      const search = page.getByRole('searchbox', { name: 'Find a tool' });
      await requireCount(search, 1, 'named tool search');
      await search.fill('messages_send');
      await page.getByText('Showing 1 of 12 tools', { exact: true }).waitFor();
      await requireCount(page.locator('.catalog-list > li:visible'), 1, 'filtered tool result');
      await search.fill('');
    },
  },
  {
    name: 'generated tool detail',
    path: '/tools/messages/send/',
    expectedText: [
      'messages_send',
      'Send a plain-text message to a Discord channel',
      'Complete input JSON Schema',
    ],
    verify: async (page) => {
      const breadcrumb = page.locator('nav[aria-label="Breadcrumb"]');
      await requireCount(breadcrumb, 1, 'tool breadcrumb');
      await requireCount(breadcrumb.locator('[aria-current="page"]'), 1, 'current breadcrumb item');
    },
  },
  {
    name: 'migration guide',
    path: '/migrate/',
    expectedText: ['Migrate', 'Available adapters', 'Three-step migration'],
    verify: async (page, viewport) => {
      if (viewport.width < 800) {
        const menuButton = page.getByRole('button', { name: 'Menu' });
        await requireCount(menuButton, 1, 'mobile navigation menu button');
        await menuButton.click();
        if ((await menuButton.getAttribute('aria-expanded')) !== 'true') {
          throw new Error('mobile navigation menu did not open');
        }
        await menuButton.press('Escape');
        if ((await menuButton.getAttribute('aria-expanded')) !== 'false') {
          throw new Error('mobile navigation menu did not close with Escape');
        }
        if (!(await menuButton.evaluate((element) => element === document.activeElement))) {
          throw new Error('closing mobile navigation did not restore menu-button focus');
        }
        return;
      }
      const developTab = page.getByRole('tab', { name: 'Develop' });
      await requireCount(developTab, 1, 'Develop navigation tab');
      if ((await developTab.getAttribute('aria-selected')) !== 'true') {
        throw new Error('Develop navigation tab is not selected for a migration route');
      }
      await requireCount(
        page.getByText('Migrate to discord-mcp', { exact: true }),
        1,
        'migration sidebar group',
      );
      await developTab.press('ArrowLeft');
      if ((await developTab.getAttribute('aria-selected')) !== 'false') {
        throw new Error('ArrowLeft did not leave the Develop navigation tab');
      }
      const keyboardSelectedTab = page.locator('sidebar-tabs [role="tab"][aria-selected="true"]');
      await requireCount(keyboardSelectedTab, 1, 'keyboard-selected sidebar tab');
      if (!(await keyboardSelectedTab.evaluate((element) => element === document.activeElement))) {
        throw new Error('keyboard-selected sidebar tab did not receive focus');
      }
      await keyboardSelectedTab.press('End');
      if (
        (await developTab.getAttribute('aria-selected')) !== 'true' ||
        !(await developTab.evaluate((element) => element === document.activeElement))
      ) {
        throw new Error('End did not restore selection and focus to the Develop tab');
      }
    },
  },
  {
    name: 'live demo',
    path: '/showcase/live-gaming-server/',
    expectedText: ['Live demo: build a gaming server', 'What the walkthrough demonstrates'],
    verify: async (page) => {
      const video = page.locator('video.live-demo-video');
      await requireCount(video, 1, 'live demo video');
      const videoSource = await video.locator('source[type="video/mp4"]').getAttribute('src');
      if (videoSource !== `${BASE_PATH}/demo/live-gaming-server-build.mp4`) {
        throw new Error('live demo MP4 source is missing or unexpected');
      }
      const videoAsset = await page.evaluate(async (source) => {
        const response = await fetch(source, {
          cache: 'no-store',
          headers: { Range: 'bytes=0-1023' },
        });
        return {
          status: response.status,
          contentType: response.headers.get('content-type'),
          bytes: (await response.arrayBuffer()).byteLength,
        };
      }, videoSource);
      if (
        videoAsset.status !== 206 ||
        videoAsset.contentType !== 'video/mp4' ||
        videoAsset.bytes !== 1024
      ) {
        throw new Error('live demo MP4 range request is unavailable or invalid');
      }
      if ((await video.getAttribute('playsinline')) === null) {
        throw new Error('live demo video lost its playsinline behavior');
      }
      if ((await video.getAttribute('muted')) === null) {
        throw new Error('silent live demo video lost its muted declaration');
      }
      if (
        (await video.getAttribute('poster')) !== `${BASE_PATH}/demo/live-gaming-server-build.webp`
      ) {
        throw new Error('live demo video poster is missing or unexpected');
      }
      const captionTrack = video.locator('track[kind="captions"][srclang="en"]');
      await requireCount(captionTrack, 1, 'caption track');
      const captionSource = await captionTrack.getAttribute('src');
      if (captionSource !== `${BASE_PATH}/demo/live-gaming-server-build.en.vtt`) {
        throw new Error('live demo caption source is missing or unexpected');
      }
      const captionAsset = await page.evaluate(async (source) => {
        const response = await fetch(source, { cache: 'no-store' });
        return {
          ok: response.ok,
          contentType: response.headers.get('content-type'),
          body: await response.text(),
        };
      }, captionSource);
      if (
        !captionAsset.ok ||
        !captionAsset.contentType?.startsWith('text/vtt') ||
        !captionAsset.body.startsWith('WEBVTT')
      ) {
        throw new Error('live demo caption asset is unavailable or invalid');
      }
      await requireCount(
        page.getByRole('link', { name: 'Download the MP4 demo (4.3 MB)' }),
        1,
        'visible video download link',
      );
      await requireCount(
        page.getByText(
          'The recording is silent: it contains no dialogue or other meaningful audio.',
        ),
        1,
        'accessible video transcript',
      );
    },
  },
];

const viewports: ViewportAudit[] = [
  { name: 'desktop light', width: 1280, height: 900, colorScheme: 'light' },
  { name: 'mobile dark', width: 390, height: 844, colorScheme: 'dark' },
];

const contentTypes: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.mp4': 'video/mp4',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.vtt': 'text/vtt; charset=utf-8',
  '.wasm': 'application/wasm',
  '.webmanifest': 'application/manifest+json',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.xml': 'application/xml; charset=utf-8',
};

async function requireCount(
  locator: ReturnType<Page['locator']>,
  expected: number,
  label: string,
): Promise<void> {
  const actual = await locator.count();
  if (actual !== expected) {
    throw new Error(`${label}: expected ${expected}, received ${actual}`);
  }
}

function resolveRequestPath(requestUrl: string): string | undefined {
  const pathname = decodeURIComponent(new URL(requestUrl, 'http://127.0.0.1').pathname);
  if (pathname !== BASE_PATH && !pathname.startsWith(`${BASE_PATH}/`)) return undefined;

  let relativePath = pathname.slice(BASE_PATH.length).replace(/^\/+/, '');
  if (relativePath === '' || relativePath.endsWith('/')) relativePath += 'index.html';

  const candidate = resolve(DIST_DIR, relativePath);
  const relativeCandidate = relative(DIST_DIR, candidate);
  if (relativeCandidate.startsWith('..') || isAbsolute(relativeCandidate)) return undefined;
  return candidate;
}

function parseRange(
  rangeHeader: string | undefined,
  size: number,
): { start: number; end: number } | undefined {
  const match = rangeHeader?.match(/^bytes=(\d+)-(\d*)$/);
  if (!match) return undefined;

  const start = Number(match[1]);
  const requestedEnd = match[2] === '' ? size - 1 : Number(match[2]);
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(requestedEnd) ||
    start > requestedEnd ||
    start >= size
  ) {
    return undefined;
  }
  return { start, end: Math.min(requestedEnd, size - 1) };
}

async function serveFile(
  request: IncomingMessage,
  response: ServerResponse,
  realDistDir: string,
): Promise<void> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { allow: 'GET, HEAD' }).end();
    return;
  }

  let filePath: string | undefined;
  try {
    filePath = resolveRequestPath(request.url ?? '/');
  } catch {
    response.writeHead(400).end();
    return;
  }

  if (!filePath) {
    response.writeHead(404).end();
    return;
  }

  let resolvedFilePath: string;
  let fileStat: Stats;
  try {
    resolvedFilePath = await realpath(filePath);
    const relativeFile = relative(realDistDir, resolvedFilePath);
    if (relativeFile.startsWith('..') || isAbsolute(relativeFile)) {
      response.writeHead(404).end();
      return;
    }
    fileStat = await stat(resolvedFilePath);
  } catch {
    response.writeHead(404).end();
    return;
  }

  if (!fileStat.isFile()) {
    response.writeHead(404).end();
    return;
  }

  const range = parseRange(request.headers.range, fileStat.size);
  const start = range?.start ?? 0;
  const end = range?.end ?? fileStat.size - 1;
  const headers: Record<string, string | number> = {
    'accept-ranges': 'bytes',
    'cache-control': 'no-store',
    'content-length': end - start + 1,
    'content-type':
      contentTypes[extname(resolvedFilePath).toLowerCase()] ?? 'application/octet-stream',
  };
  if (range) headers['content-range'] = `bytes ${start}-${end}/${fileStat.size}`;

  response.writeHead(range ? 206 : 200, headers);
  if (request.method === 'HEAD') {
    response.end();
    return;
  }

  createReadStream(resolvedFilePath, { start, end })
    .on('error', () => response.destroy())
    .pipe(response);
}

async function startStaticServer(): Promise<{ origin: string; close: () => Promise<void> }> {
  await access(join(DIST_DIR, 'index.html')).catch(() => {
    throw new Error('site/dist is missing; run `pnpm --filter site build` before this audit');
  });
  const realDistDir = await realpath(DIST_DIR);

  const server = createServer((request, response) => {
    void serveFile(request, response, realDistDir).catch((error: unknown) => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
      console.error(error);
    });
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('rendered-docs server did not expose a TCP port');
  }

  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => (error ? rejectClose(error) : resolveClose()));
      }),
  };
}

function formatAxeFinding(
  finding: Awaited<ReturnType<AxeBuilder['analyze']>>['violations'][number],
): string {
  const targets = finding.nodes.flatMap((node) => node.target.map((target) => String(target)));
  const visibleTargets = targets.slice(0, 5).join(', ');
  const omittedTargets = targets.length > 5 ? `, +${targets.length - 5} more` : '';
  return `${finding.id} [${finding.impact ?? 'unknown'}] ${finding.help} (${visibleTargets}${omittedTargets}) ${finding.helpUrl}`;
}

async function auditScenario(
  browser: Browser,
  origin: string,
  route: RouteAudit,
  viewport: ViewportAudit,
): Promise<void> {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    colorScheme: viewport.colorScheme,
    reducedMotion: 'reduce',
    locale: 'en-US',
  });
  const page = await context.newPage();
  const runtimeErrors: string[] = [];
  const localHttpErrors: string[] = [];

  page.on('console', (message) => {
    if (message.type() === 'error') runtimeErrors.push(`console: ${message.text()}`);
  });
  page.on('pageerror', (error) => runtimeErrors.push(`pageerror: ${error.message}`));
  page.on('requestfailed', (request) => {
    if (request.url().startsWith(origin) && request.resourceType() !== 'media') {
      runtimeErrors.push(
        `requestfailed: ${request.method()} ${request.url()} (${request.failure()?.errorText})`,
      );
    }
  });
  page.on('response', (response) => {
    if (response.url().startsWith(origin) && response.status() >= 400) {
      localHttpErrors.push(`${response.status()} ${response.url()}`);
    }
  });

  const label = `${route.name} / ${viewport.name}`;
  try {
    const response = await page.goto(`${origin}${BASE_PATH}${route.path}`, { waitUntil: 'load' });
    if (!response?.ok()) {
      throw new Error(`document response failed: ${response?.status() ?? 'missing response'}`);
    }
    await page.evaluate(async () => {
      await document.fonts.ready;
    });

    await requireCount(page.locator('main h1:visible'), 1, 'visible main heading');
    const bodyText = await page.locator('body').innerText();
    for (const expected of route.expectedText) {
      if (!bodyText.includes(expected)) {
        throw new Error(`missing rendered text: ${JSON.stringify(expected)}`);
      }
    }
    await route.verify?.(page, viewport);

    const managedScrollRegions = page.locator('[data-keyboard-scroll]');
    const invalidManagedScrollRegions = await managedScrollRegions.evaluateAll((elements) =>
      elements
        .filter(
          (element) =>
            !(element instanceof HTMLElement) ||
            element.tabIndex !== 0 ||
            element.scrollWidth <= element.clientWidth + 1,
        )
        .map((element) => element.outerHTML.slice(0, 160)),
    );
    if (invalidManagedScrollRegions.length > 0) {
      throw new Error(
        `managed horizontal scroll regions are not keyboard-ready:\n${invalidManagedScrollRegions.join('\n')}`,
      );
    }
    if ((await managedScrollRegions.count()) > 0) {
      const firstManagedScrollRegion = managedScrollRegions.first();
      await firstManagedScrollRegion.focus();
      if (
        !(await firstManagedScrollRegion.evaluate((element) => element === document.activeElement))
      ) {
        throw new Error('managed horizontal scroll region could not receive keyboard focus');
      }
    }

    const dimensions = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
    }));
    if (dimensions.scrollWidth > dimensions.clientWidth + 1) {
      throw new Error(
        `horizontal overflow: ${dimensions.scrollWidth}px > ${dimensions.clientWidth}px`,
      );
    }

    const axe = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
    for (const incomplete of axe.incomplete) {
      console.warn(`  ? ${label}: manual review: ${formatAxeFinding(incomplete)}`);
    }
    const blockingIncomplete = axe.incomplete.filter(
      (finding) =>
        BLOCKING_INCOMPLETE_IMPACTS.has(finding.impact ?? '') &&
        !MANUAL_REVIEW_ONLY_INCOMPLETE_RULES.has(finding.id),
    );
    if (blockingIncomplete.length > 0) {
      throw new Error(
        `unreviewed serious accessibility findings:\n${blockingIncomplete.map(formatAxeFinding).join('\n')}`,
      );
    }
    if (axe.violations.length > 0) {
      throw new Error(
        `accessibility violations:\n${axe.violations.map(formatAxeFinding).join('\n')}`,
      );
    }

    if (localHttpErrors.length > 0) {
      throw new Error(`local HTTP errors:\n${localHttpErrors.join('\n')}`);
    }
    if (runtimeErrors.length > 0) {
      throw new Error(`browser runtime errors:\n${runtimeErrors.join('\n')}`);
    }

    console.log(
      `✓ ${label}: ${axe.passes.length} axe passes, ${axe.incomplete.length} incomplete, 0 violations`,
    );
  } catch (error) {
    throw new Error(`${label}: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await context.close();
  }
}

const staticServer = await startStaticServer();
let browser: Browser | undefined;

try {
  browser = await chromium.launch({ headless: true });
  for (const viewport of viewports) {
    for (const route of routes) await auditScenario(browser, staticServer.origin, route, viewport);
  }
  console.log(`Rendered docs audit passed ${routes.length * viewports.length} browser scenarios.`);
} finally {
  await browser?.close();
  await staticServer.close();
}
