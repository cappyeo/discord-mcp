import { createReadStream, type Stats } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AxeBuilder } from '@axe-core/playwright';
import { type Browser, chromium, type Page } from 'playwright';
import sharp from 'sharp';
import {
  compositeColor,
  contrastRatio,
  parseCssColor,
  type RgbaColor,
  requiredContrastRatio,
} from './rendered-contrast.js';

const SCRIPT_DIR = fileURLToPath(new URL('.', import.meta.url));
const DIST_DIR = resolve(SCRIPT_DIR, '../dist');
const BASE_PATH = '/discord-mcp';
const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'];
const BLOCKING_INCOMPLETE_IMPACTS = new Set(['critical', 'serious']);

type AxeResults = Awaited<ReturnType<AxeBuilder['analyze']>>;
type AxeFinding = AxeResults['violations'][number];
type AxeNode = AxeFinding['nodes'][number];

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

interface ContrastBackgroundLayer {
  backgroundColor: string;
  backgroundImage: string;
  backdropFilter: string;
  boxShadow: string;
  filter: string;
  mixBlendMode: string;
  opacity: string;
}

interface ContrastProbe {
  backgrounds: ContrastBackgroundLayer[];
  elementHeight: number;
  elementWidth: number;
  fontSize: number;
  fontWeight: number;
  foreground: string;
  id: string;
  requiresRenderedSample: boolean;
  selector: string;
  text: string;
  textRects: Array<{ bottom: number; left: number; right: number; top: number }>;
  unsupportedForegroundEffects: string[];
}

interface ContrastEvidence {
  minimumRatio: number;
  probeCount: number;
  reasons: string;
  renderedSampleCount: number;
}

const routes: RouteAudit[] = [
  {
    name: 'homepage',
    path: '/',
    expectedText: ['Connect your AI to Discord', 'Get a verified result', '208 tools'],
  },
  {
    name: 'first verified outcome journey',
    path: '/',
    expectedText: ['Connect your AI to Discord', 'Get a verified result', 'Activity Evidence'],
    verify: async (page) => {
      const getVerified = page.getByRole('link', { name: 'Get a verified result', exact: true });
      await requireCount(getVerified, 1, 'primary verified-outcome entry');
      await getVerified.click();
      await page.waitForURL((url) => url.pathname === `${BASE_PATH}/start/activity-evidence/`);
      await requireCount(
        page.getByRole('heading', {
          level: 1,
          name: 'Get your first verified Discord outcome',
          exact: true,
        }),
        1,
        'verified outcome heading',
      );
      await requireCount(
        page.getByRole('heading', { level: 2, name: 'What success looks like', exact: true }),
        1,
        'verified outcome success contract',
      );
    },
  },
  {
    name: 'site search journey',
    path: '/',
    expectedText: ['Connect your AI to Discord', 'Start from your goal'],
    verify: async (page, viewport) => {
      const journey =
        viewport.width < 800
          ? {
              query: 'permissions_audit_channel',
              title: 'permissions_audit_channel',
              path: '/tools/permissions/audit_channel/',
            }
          : {
              query: 'connection mode',
              title: 'Choose a connection mode',
              path: '/operations/clients/',
            };

      const searchButton = page.getByRole('button', { name: 'Search', exact: true });
      await requireCount(searchButton, 1, 'site search button');
      await searchButton.click();

      const dialog = page.getByRole('dialog', { name: 'Search' });
      await dialog.waitFor({ state: 'visible' });
      await requireCount(dialog, 1, 'site search dialog');
      const siteSearch = dialog.getByRole('search', { name: 'Search this site' });
      await siteSearch.waitFor({ state: 'visible' });
      await requireCount(siteSearch, 1, 'named site search');
      const searchbox = siteSearch.getByRole('textbox', { name: 'Search' });
      await searchbox.waitFor({ state: 'visible' });
      await requireCount(searchbox, 1, 'site search textbox');
      if (!(await searchbox.evaluate((element) => element === document.activeElement))) {
        throw new Error('opening site search did not focus the search textbox');
      }

      await searchbox.fill(journey.query);
      const result = siteSearch.locator(`a[href="${BASE_PATH}${journey.path}"]`, {
        hasText: journey.title,
      });
      await result.waitFor({ state: 'visible' });
      await requireCount(result, 1, `search result for ${journey.query}`);
      await result.click();
      await page.waitForURL((url) => url.pathname === `${BASE_PATH}${journey.path}`);
      await requireCount(
        page.getByRole('heading', { level: 1, name: journey.title, exact: true }),
        1,
        `search destination heading for ${journey.query}`,
      );
      await requireCount(page.getByRole('dialog', { name: 'Search' }), 0, 'closed search dialog');
    },
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
    name: 'connection mode guide',
    path: '/operations/clients/',
    expectedText: [
      'Choose a connection mode',
      'Local stdio + progressive',
      'Streamable HTTP + full',
      'Gateway is not a transport',
    ],
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

function formatAxeFinding(finding: AxeFinding): string {
  const targets = finding.nodes.flatMap((node) => node.target.map((target) => String(target)));
  const visibleTargets = targets.slice(0, 5).join(', ');
  const omittedTargets = targets.length > 5 ? `, +${targets.length - 5} more` : '';
  return `${finding.id} [${finding.impact ?? 'unknown'}] ${finding.help} (${visibleTargets}${omittedTargets}) ${finding.helpUrl}`;
}

let contrastProbeSequence = 0;

function axeNodeSelector(node: AxeNode): string {
  if (node.target.length !== 1 || typeof node.target[0] !== 'string') {
    throw new Error(`unsupported axe contrast target: ${JSON.stringify(node.target)}`);
  }
  return node.target[0];
}

function axeContrastReasons(node: AxeNode): string[] {
  return node.any.flatMap((check) => {
    const messageKey = (check.data as { messageKey?: unknown } | null)?.messageKey;
    return typeof messageKey === 'string' ? [messageKey] : [];
  });
}

async function collectContrastProbes(page: Page, node: AxeNode): Promise<ContrastProbe[]> {
  const selector = axeNodeSelector(node);
  const target = page.locator(selector);
  await requireCount(target, 1, `axe contrast target ${selector}`);
  const prefix = `rendered-contrast-${++contrastProbeSequence}`;
  const forceRenderedSample = axeContrastReasons(node).some((reason) =>
    ['bgGradient', 'bgOverlap', 'elmPartiallyObscured', 'elmPartiallyObscuring'].includes(reason),
  );

  return target.evaluate(
    (
      element,
      { forceRenderedSample: forceSample, prefix: probePrefix, selector: targetSelector },
    ) => {
      const visibleTextElements = [element, ...element.querySelectorAll('*')].filter(
        (candidate) => {
          const hasDirectText = [...candidate.childNodes].some(
            (child) => child.nodeType === Node.TEXT_NODE && Boolean(child.textContent?.trim()),
          );
          if (!hasDirectText) return false;

          const styles = getComputedStyle(candidate);
          const bounds = candidate.getBoundingClientRect();
          return (
            styles.display !== 'none' &&
            styles.visibility !== 'hidden' &&
            Number.parseFloat(styles.opacity) > 0 &&
            bounds.width > 0 &&
            bounds.height > 0
          );
        },
      );

      return visibleTextElements.map((candidate, index) => {
        const styles = getComputedStyle(candidate);
        const candidateBounds = candidate.getBoundingClientRect();
        const id = `${probePrefix}-${index}`;
        candidate.setAttribute('data-rendered-contrast-probe', id);
        const backgrounds = [];
        const unsupportedForegroundEffects = [];
        let hasComplexPseudoBackground = false;

        for (let current: Element | null = candidate; current; current = current.parentElement) {
          const currentStyles = getComputedStyle(current);
          backgrounds.push({
            backgroundColor: currentStyles.backgroundColor,
            backgroundImage: currentStyles.backgroundImage,
            backdropFilter: currentStyles.backdropFilter,
            boxShadow: currentStyles.boxShadow,
            filter: currentStyles.filter,
            mixBlendMode: currentStyles.mixBlendMode,
            opacity: currentStyles.opacity,
          });
          if (Number.parseFloat(currentStyles.opacity) !== 1) {
            unsupportedForegroundEffects.push(`${current.tagName.toLowerCase()} opacity`);
          }
          if (currentStyles.filter !== 'none') {
            unsupportedForegroundEffects.push(`${current.tagName.toLowerCase()} filter`);
          }
          if (currentStyles.mixBlendMode !== 'normal') {
            unsupportedForegroundEffects.push(`${current.tagName.toLowerCase()} mix-blend-mode`);
          }
          for (const pseudoName of ['::before', '::after'] as const) {
            const pseudo = getComputedStyle(current, pseudoName);
            const transparentBackground =
              pseudo.backgroundColor === 'rgba(0, 0, 0, 0)' ||
              pseudo.backgroundColor === 'transparent';
            if (
              pseudo.content !== 'none' &&
              (!transparentBackground ||
                pseudo.backgroundImage !== 'none' ||
                pseudo.backdropFilter !== 'none' ||
                pseudo.boxShadow !== 'none')
            ) {
              hasComplexPseudoBackground = true;
            }
          }
        }
        if (styles.textShadow !== 'none') unsupportedForegroundEffects.push('text-shadow');

        const usesSvgFill =
          candidate.namespaceURI === 'http://www.w3.org/2000/svg' &&
          candidate.tagName.toLowerCase() === 'text';
        const webkitTextFillColor = styles.getPropertyValue('-webkit-text-fill-color').trim();
        const effectiveTextColor =
          webkitTextFillColor && webkitTextFillColor.toLowerCase() !== 'currentcolor'
            ? webkitTextFillColor
            : styles.color;
        const textRects = [...candidate.childNodes]
          .filter(
            (child) => child.nodeType === Node.TEXT_NODE && Boolean(child.textContent?.trim()),
          )
          .flatMap((child) => {
            const range = document.createRange();
            range.selectNodeContents(child);
            return [...range.getClientRects()].map((rect) => ({
              bottom: Math.min(candidateBounds.height, rect.bottom - candidateBounds.top),
              left: Math.max(0, rect.left - candidateBounds.left),
              right: Math.min(candidateBounds.width, rect.right - candidateBounds.left),
              top: Math.max(0, rect.top - candidateBounds.top),
            }));
          })
          .filter((rect) => rect.right > rect.left && rect.bottom > rect.top);
        return {
          backgrounds,
          elementHeight: candidateBounds.height,
          elementWidth: candidateBounds.width,
          fontSize: Number.parseFloat(styles.fontSize),
          fontWeight: Number.parseFloat(styles.fontWeight) || 400,
          foreground: usesSvgFill ? styles.fill : effectiveTextColor,
          id,
          requiresRenderedSample: forceSample || hasComplexPseudoBackground,
          selector: targetSelector,
          text: [...candidate.childNodes]
            .filter((child) => child.nodeType === Node.TEXT_NODE)
            .map((child) => child.textContent ?? '')
            .join(' ')
            .trim()
            .replace(/\s+/g, ' ')
            .slice(0, 80),
          textRects,
          unsupportedForegroundEffects,
        };
      });
    },
    { forceRenderedSample, prefix, selector },
  );
}

function resolveSolidBackground(probe: ContrastProbe): RgbaColor | undefined {
  let background: RgbaColor = { red: 0, green: 0, blue: 0, alpha: 0 };

  for (const layer of probe.backgrounds) {
    if (
      layer.backgroundImage !== 'none' ||
      layer.backdropFilter !== 'none' ||
      layer.boxShadow !== 'none' ||
      layer.filter !== 'none'
    ) {
      return undefined;
    }

    const layerColor = parseCssColor(layer.backgroundColor);
    if (!layerColor) return undefined;
    background = compositeColor(background, layerColor);
    if (background.alpha >= 0.999) return background;
  }

  return undefined;
}

function verifiedRatio(
  foreground: RgbaColor,
  background: RgbaColor,
  requiredRatio: number,
  probe: ContrastProbe,
): number {
  const renderedForeground = compositeColor(foreground, background);
  const ratio = contrastRatio(renderedForeground, background);
  if (ratio < requiredRatio) {
    throw new Error(
      `contrast ${ratio.toFixed(2)}:1 is below ${requiredRatio}:1 for ${probe.selector} ` +
        `(${JSON.stringify(probe.text)}; foreground ${probe.foreground}; ` +
        `background rgb(${background.red.toFixed(0)} ${background.green.toFixed(0)} ${background.blue.toFixed(0)}))`,
    );
  }
  return ratio;
}

async function sampleRenderedBackground(
  page: Page,
  probe: ContrastProbe,
  foreground: RgbaColor,
  requiredRatio: number,
): Promise<number> {
  const locator = page.locator(`[data-rendered-contrast-probe="${probe.id}"]`);
  await requireCount(locator, 1, `rendered contrast probe ${probe.id}`);
  await locator.evaluate((element) => {
    element.scrollIntoView({ block: 'center', inline: 'center' });
  });
  await page.evaluate(
    () => new Promise<void>((resolveFrame) => requestAnimationFrame(() => resolveFrame())),
  );

  await page.evaluate((id) => {
    const style = document.createElement('style');
    style.dataset.renderedContrastStyle = id;
    style.textContent = `
      [data-rendered-contrast-probe="${CSS.escape(id)}"],
      [data-rendered-contrast-probe="${CSS.escape(id)}"] * {
        color: transparent !important;
        fill: transparent !important;
        stroke: transparent !important;
        text-decoration-color: transparent !important;
        text-shadow: none !important;
        -webkit-text-fill-color: transparent !important;
      }
    `;
    document.head.append(style);
  }, probe.id);

  try {
    await page.evaluate(
      () => new Promise<void>((resolveFrame) => requestAnimationFrame(() => resolveFrame())),
    );
    const screenshot = await locator.screenshot({ animations: 'disabled', scale: 'css' });
    const { data, info } = await sharp(screenshot)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const horizontalScale = info.width / probe.elementWidth;
    const verticalScale = info.height / probe.elementHeight;
    const samplingRects =
      probe.textRects.length > 0
        ? probe.textRects
        : [{ bottom: probe.elementHeight, left: 0, right: probe.elementWidth, top: 0 }];
    let minimumRatio = Number.POSITIVE_INFINITY;
    let minimumBackground: RgbaColor | undefined;

    for (const rect of samplingRects) {
      const startX = Math.max(0, Math.floor(rect.left * horizontalScale));
      const endX = Math.min(info.width, Math.ceil(rect.right * horizontalScale));
      const startY = Math.max(0, Math.floor(rect.top * verticalScale));
      const endY = Math.min(info.height, Math.ceil(rect.bottom * verticalScale));
      for (let y = startY; y < endY; y += 1) {
        for (let x = startX; x < endX; x += 1) {
          const offset = (y * info.width + x) * info.channels;
          if (data[offset + 3] < 250) continue;
          const pixel: RgbaColor = {
            red: data[offset],
            green: data[offset + 1],
            blue: data[offset + 2],
            alpha: 1,
          };
          const ratio = contrastRatio(compositeColor(foreground, pixel), pixel);
          if (ratio < minimumRatio) {
            minimumRatio = ratio;
            minimumBackground = pixel;
          }
        }
      }
    }

    if (!Number.isFinite(minimumRatio) || !minimumBackground) {
      throw new Error(`rendered contrast probe ${probe.id} produced no pixels`);
    }
    return verifiedRatio(foreground, minimumBackground, requiredRatio, probe);
  } finally {
    await page.evaluate((id) => {
      document.querySelector(`style[data-rendered-contrast-style="${CSS.escape(id)}"]`)?.remove();
    }, probe.id);
  }
}

async function verifyIncompleteColorContrast(
  page: Page,
  finding: AxeFinding,
): Promise<ContrastEvidence> {
  let minimumRatio = Number.POSITIVE_INFINITY;
  let probeCount = 0;
  let renderedSampleCount = 0;
  const reasonCounts = new Map<string, number>();

  for (const node of finding.nodes) {
    for (const reason of axeContrastReasons(node)) {
      reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
    }
    const probes = await collectContrastProbes(page, node);
    if (probes.length === 0) {
      throw new Error(`axe contrast target has no visible text: ${axeNodeSelector(node)}`);
    }

    try {
      for (const probe of probes) {
        if (probe.unsupportedForegroundEffects.length > 0) {
          throw new Error(
            `unsupported foreground effects for ${probe.selector}: ${probe.unsupportedForegroundEffects.join(', ')}`,
          );
        }
        const foreground = parseCssColor(probe.foreground);
        if (!foreground || foreground.alpha === 0) {
          throw new Error(
            `cannot resolve foreground ${JSON.stringify(probe.foreground)} for ${probe.selector}`,
          );
        }
        const requiredRatio = requiredContrastRatio(probe.fontSize, probe.fontWeight);
        const background = probe.requiresRenderedSample ? undefined : resolveSolidBackground(probe);
        const ratio = background
          ? verifiedRatio(foreground, background, requiredRatio, probe)
          : await sampleRenderedBackground(page, probe, foreground, requiredRatio);
        if (!background) renderedSampleCount += 1;
        minimumRatio = Math.min(minimumRatio, ratio);
        probeCount += 1;
      }
    } finally {
      await page
        .locator(`[data-rendered-contrast-probe^="rendered-contrast-"]`)
        .evaluateAll((elements) => {
          for (const element of elements) {
            element.removeAttribute('data-rendered-contrast-probe');
          }
        });
    }
  }

  if (!Number.isFinite(minimumRatio) || probeCount === 0) {
    throw new Error('axe returned a color-contrast finding without verifiable evidence');
  }
  const reasons = [...reasonCounts.entries()]
    .sort(([first], [second]) => first.localeCompare(second))
    .map(([reason, count]) => `${reason}=${count}`)
    .join(', ');
  return { minimumRatio, probeCount, reasons, renderedSampleCount };
}

async function verifyContrastGateCanary(browser: Browser): Promise<void> {
  const context = await browser.newContext({ viewport: { width: 320, height: 180 } });
  const page = await context.newPage();

  const verifyCanary = async (
    foreground: string,
    shouldPass: boolean,
    textFillColor = 'currentcolor',
  ): Promise<void> => {
    await page.setContent(`
      <!doctype html>
      <html lang="en">
        <body style="margin: 0; background: white">
          <p style="margin: 1rem; padding: 1rem; color: ${foreground}; -webkit-text-fill-color: ${textFillColor}; background: linear-gradient(90deg, #f8f8fa, #d8dce8)">
            Rendered contrast canary
          </p>
        </body>
      </html>
    `);
    const axe = await new AxeBuilder({ page }).withRules(['color-contrast']).analyze();
    const finding = axe.incomplete.find((candidate) => candidate.id === 'color-contrast');
    if (!finding) throw new Error('rendered contrast canary did not produce an axe incomplete');

    try {
      await verifyIncompleteColorContrast(page, finding);
      if (!shouldPass) throw new Error('rendered contrast gate accepted its intentional failure');
    } catch (error) {
      if (shouldPass) throw error;
      if (!(error instanceof Error) || !error.message.includes('is below')) throw error;
    }
  };

  try {
    await verifyCanary('rgb(17 17 20)', true);
    await verifyCanary('rgb(190 194 204)', false);
    await verifyCanary('rgb(17 17 20)', false, 'rgb(190 194 204)');
    console.log('✓ rendered contrast gate canary: accepted AA and rejected sub-AA color/text-fill');
  } finally {
    await context.close();
  }
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
    const verifiedIncomplete = new Set<AxeFinding>();
    for (const incomplete of axe.incomplete) {
      if (incomplete.id === 'color-contrast') {
        const evidence = await verifyIncompleteColorContrast(page, incomplete);
        verifiedIncomplete.add(incomplete);
        console.log(
          `  ✓ ${label}: verified ${evidence.probeCount} indeterminate contrast samples ` +
            `(minimum ${evidence.minimumRatio.toFixed(2)}:1; ${evidence.renderedSampleCount} rendered backgrounds; ` +
            `${evidence.reasons || 'unclassified'})`,
        );
      } else {
        console.warn(`  ? ${label}: manual review: ${formatAxeFinding(incomplete)}`);
      }
    }
    const blockingIncomplete = axe.incomplete.filter(
      (finding) =>
        BLOCKING_INCOMPLETE_IMPACTS.has(finding.impact ?? '') && !verifiedIncomplete.has(finding),
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
  await verifyContrastGateCanary(browser);
  for (const viewport of viewports) {
    for (const route of routes) await auditScenario(browser, staticServer.origin, route, viewport);
  }
  console.log(`Rendered docs audit passed ${routes.length * viewports.length} browser scenarios.`);
} finally {
  await browser?.close();
  await staticServer.close();
}
