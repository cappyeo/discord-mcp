import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface MonitoredExternalLink {
  /** Extra hosts explicitly accepted after following redirects from this link. */
  allowedRedirectHosts?: readonly string[];
  label: string;
  sourceFile: string;
  sourceUrl: string;
  /** Machine-readable fallback, consulted only when sourceUrl is access-controlled. */
  validationUrl?: string;
}

export type ExternalFetch = typeof fetch;
export type ExternalLinkStatus = 'healthy' | 'broken' | 'indeterminate';

export interface ExternalLinkResult {
  attempts: number;
  finalUrl?: string;
  httpStatus?: number;
  link: MonitoredExternalLink;
  reason: string;
  status: ExternalLinkStatus;
}

export interface ExternalLinkSummary {
  brokenCount: number;
  healthyCount: number;
  indeterminateCount: number;
  results: ExternalLinkResult[];
}

interface ExternalCheckOptions {
  fetch?: ExternalFetch;
  maxAttempts?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  timeoutMs?: number;
}

interface VerifyExternalLinksOptions extends ExternalCheckOptions {
  concurrency?: number;
}

const DEFAULT_CONCURRENCY = 4;
const DEFAULT_MAX_ATTEMPTS = 2;
const DEFAULT_TIMEOUT_MS = 10_000;
const RETRYABLE_STATUSES = new Set([408, 425, 429]);
const INDETERMINATE_STATUSES = new Set([401, 403, 405]);
const PLACEHOLDER_HOSTS = new Set([
  '127.0.0.1',
  '[::1]',
  'example.com',
  'example.net',
  'example.org',
  'localhost',
]);

/**
 * A bounded monitor for high-impact user journeys, not a full external crawler.
 * Deliberately exclude example/local URLs, badges, media, and generated source links.
 * This verifies reachability and redirect hosts, not dynamic page content or fragments.
 */
export const monitoredExternalLinks: readonly MonitoredExternalLink[] = [
  {
    label: 'Discord Developer Portal',
    sourceFile: 'site/src/content/docs/start/create-discord-bot.mdx',
    sourceUrl: 'https://discord.com/developers/applications',
  },
  {
    allowedRedirectHosts: ['docs.discord.com'],
    label: 'Discord onboarding object',
    sourceFile: 'packages/mcp-core/src/tools/onboarding/get.ts',
    sourceUrl: 'https://discord.com/developers/docs/resources/guild#guild-onboarding-object',
  },
  {
    label: 'Discord onboarding prompt structure',
    sourceFile: 'packages/mcp-core/src/tools/onboarding/modify.ts',
    sourceUrl:
      'https://docs.discord.com/developers/resources/guild#guild-onboarding-object-onboarding-prompt-structure',
  },
  {
    label: 'MCP documentation',
    sourceFile: 'site/src/content/docs/architecture/index.mdx',
    sourceUrl: 'https://modelcontextprotocol.io',
  },
  {
    label: 'MCP Registry record',
    sourceFile: 'site/public/llms.txt',
    sourceUrl:
      'https://registry.modelcontextprotocol.io/v0.1/servers/io.github.cappyeo%2Fdiscord-mcp/versions/latest',
  },
  {
    label: 'OpenAI MCP and Connectors guide',
    sourceFile: 'site/src/content/docs/operations/openai.mdx',
    sourceUrl: 'https://developers.openai.com/api/docs/guides/tools-connectors-mcp',
  },
  {
    label: 'OpenAI tool search guide',
    sourceFile: 'site/src/content/docs/operations/openai.mdx',
    sourceUrl: 'https://developers.openai.com/api/docs/guides/tools-tool-search',
  },
  {
    label: 'Codex configuration reference',
    sourceFile: 'site/src/content/docs/operations/openai.mdx',
    sourceUrl: 'https://learn.chatgpt.com/docs/config-file/config-reference',
  },
  {
    label: 'Grok Build MCP documentation',
    sourceFile: 'site/src/content/docs/start/client-setup.mdx',
    sourceUrl: 'https://docs.x.ai/build/features/mcp-servers',
  },
  {
    label: '@discord-mcp/cli package',
    sourceFile: 'site/public/llms.txt',
    sourceUrl: 'https://www.npmjs.com/package/@discord-mcp/cli',
    validationUrl: 'https://registry.npmjs.org/@discord-mcp%2fcli',
  },
  {
    label: '@discord-mcp/core package',
    sourceFile: 'site/public/llms.txt',
    sourceUrl: 'https://www.npmjs.com/package/@discord-mcp/core',
    validationUrl: 'https://registry.npmjs.org/@discord-mcp%2fcore',
  },
  {
    label: 'MCP Inspector',
    sourceFile: 'README.md',
    sourceUrl: 'https://github.com/modelcontextprotocol/inspector',
  },
  {
    label: 'discord-ops migration source',
    sourceFile: 'site/src/content/docs/migrate/discord-ops.mdx',
    sourceUrl: 'https://github.com/bookedsolidtech/discord-ops',
  },
  {
    label: 'Hubdustry reference fixture',
    sourceFile: 'site/src/content/docs/migrate/hubdustry.mdx',
    sourceUrl:
      'https://github.com/cappyeo/discord-mcp/tree/main/packages/mcp-server/test-fixtures/hubdustry-go-mcp/apps/mcp',
  },
  {
    label: 'PaSympa migration source',
    sourceFile: 'site/src/content/docs/migrate/pasympa.mdx',
    sourceUrl: 'https://github.com/PaSympa/discord-mcp',
  },
  {
    label: 'Quadslab migration source',
    sourceFile: 'site/src/content/docs/migrate/quadslab.mdx',
    sourceUrl: 'https://github.com/HardHeadHackerHead/discord-mcp',
  },
];

function parseHttpsUrl(value: string, description: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${description} must be a valid URL: ${JSON.stringify(value)}`);
  }

  if (url.protocol !== 'https:') {
    throw new Error(`${description} must use HTTPS: ${JSON.stringify(value)}`);
  }
  if (url.username || url.password) {
    throw new Error(`${description} must not contain credentials: ${JSON.stringify(value)}`);
  }

  const hostname = url.hostname.toLowerCase();
  if (
    PLACEHOLDER_HOSTS.has(hostname) ||
    hostname.endsWith('.example') ||
    hostname.endsWith('.invalid') ||
    hostname.endsWith('.test')
  ) {
    throw new Error(`${description} must not use a placeholder host: ${JSON.stringify(value)}`);
  }
  return url;
}

function isRepositoryRelativePath(value: string): boolean {
  if (!value || isAbsolute(value) || value.includes('\\')) return false;
  return value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

export function validateExternalLinkManifest(links: readonly MonitoredExternalLink[]): void {
  if (links.length === 0) throw new Error('external link manifest must not be empty');

  const labels = new Set<string>();
  const sourceLinks = new Set<string>();
  const targets = new Set<string>();
  for (const link of links) {
    if (!link.label.trim()) throw new Error('external link label must not be empty');
    if (labels.has(link.label)) throw new Error(`duplicate external link label: ${link.label}`);
    labels.add(link.label);

    if (!isRepositoryRelativePath(link.sourceFile)) {
      throw new Error(
        `external link sourceFile must be a relative repository path: ${JSON.stringify(link.sourceFile)}`,
      );
    }
    parseHttpsUrl(link.sourceUrl, `${link.label} sourceUrl`);
    if (link.validationUrl !== undefined) {
      parseHttpsUrl(link.validationUrl, `${link.label} validationUrl`);
      if (link.validationUrl === link.sourceUrl) {
        throw new Error(`${link.label} validationUrl must differ from sourceUrl`);
      }
    }
    const redirectHosts = new Set<string>();
    for (const host of link.allowedRedirectHosts ?? []) {
      const parsedHost = parseHttpsUrl(`https://${host}`, `${link.label} allowed redirect host`);
      if (host.toLowerCase() !== parsedHost.hostname.toLowerCase()) {
        throw new Error(`${link.label} allowed redirect host must be a hostname: ${host}`);
      }
      const normalizedHost = parsedHost.hostname.toLowerCase();
      if (redirectHosts.has(normalizedHost)) {
        throw new Error(`${link.label} has duplicate allowed redirect host: ${host}`);
      }
      redirectHosts.add(normalizedHost);
    }

    const sourceKey = `${link.sourceFile}\0${link.sourceUrl}`;
    if (sourceLinks.has(sourceKey)) {
      throw new Error(`duplicate source link: ${link.sourceFile} -> ${link.sourceUrl}`);
    }
    sourceLinks.add(sourceKey);

    for (const target of [link.sourceUrl, link.validationUrl]) {
      if (target === undefined) continue;
      if (targets.has(target)) throw new Error(`duplicate request target: ${target}`);
      targets.add(target);
    }
  }
}

export async function verifyExternalLinkSources(
  repositoryRoot: string,
  links: readonly MonitoredExternalLink[],
): Promise<void> {
  validateExternalLinkManifest(links);
  const root = await realpath(resolve(repositoryRoot));
  const issues = await Promise.all(
    links.map(async (link): Promise<string | undefined> => {
      const requestedSourcePath = resolve(root, ...link.sourceFile.split('/'));
      const requestedRelativePath = relative(root, requestedSourcePath);
      if (
        requestedRelativePath === '..' ||
        requestedRelativePath.startsWith(`..${sep}`) ||
        isAbsolute(requestedRelativePath)
      ) {
        return `${link.sourceFile}: resolved outside the repository`;
      }

      try {
        const sourcePath = await realpath(requestedSourcePath);
        const relativePath = relative(root, sourcePath);
        if (
          relativePath === '..' ||
          relativePath.startsWith(`..${sep}`) ||
          isAbsolute(relativePath)
        ) {
          return `${link.sourceFile}: symlink resolves outside the repository`;
        }
        const source = await readFile(sourcePath, 'utf8');
        if (!source.includes(link.sourceUrl)) {
          return `${link.sourceFile}: does not contain ${link.sourceUrl}`;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return `${link.sourceFile}: could not be read (${message})`;
      }
      return undefined;
    }),
  );
  const visibleIssues = issues.filter((issue): issue is string => issue !== undefined).sort();
  if (visibleIssues.length > 0) {
    throw new Error(
      `[verify-external-links] manifest source drift\n${visibleIssues.map((issue) => `- ${issue}`).join('\n')}`,
    );
  }
}

function positiveInteger(value: number, description: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${description} must be a positive integer`);
  }
  return value;
}

async function defaultSleep(milliseconds: number): Promise<void> {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Link health depends on the response headers, not cleanup of an unread body.
  }
}

function result(
  link: MonitoredExternalLink,
  status: ExternalLinkStatus,
  reason: string,
  attempts: number,
  target: string,
  response?: Response,
): ExternalLinkResult {
  return {
    attempts,
    finalUrl: response?.url || target,
    httpStatus: response?.status,
    link,
    reason,
    status,
  };
}

function isRetryableStatus(status: number): boolean {
  return RETRYABLE_STATUSES.has(status) || status >= 500;
}

function networkFailureReason(error: unknown): string {
  if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
    return 'request timed out';
  }
  return 'network request failed';
}

async function probeExternalUrl(
  link: MonitoredExternalLink,
  target: string,
  options: ExternalCheckOptions,
): Promise<ExternalLinkResult> {
  const fetchExternal = options.fetch ?? fetch;
  const maxAttempts = positiveInteger(options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS, 'maxAttempts');
  const sleep = options.sleep ?? defaultSleep;
  const timeoutMs = positiveInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 'timeoutMs');
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetchExternal(target, {
        headers: {
          accept: 'text/html,application/json;q=0.9,*/*;q=0.8',
          'user-agent': 'discord-mcp-docs-link-check/1.0 (+https://github.com/cappyeo/discord-mcp)',
        },
        method: 'GET',
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs),
      });
      await cancelResponseBody(response);

      const finalUrl = response.url || target;
      let parsedFinalUrl: URL;
      try {
        parsedFinalUrl = parseHttpsUrl(finalUrl, `${link.label} final URL`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return result(link, 'broken', `unsafe final URL: ${message}`, attempt, target, response);
      }
      const expectedHosts = new Set([
        new URL(target).hostname.toLowerCase(),
        ...(link.allowedRedirectHosts ?? []).map((host) => host.toLowerCase()),
      ]);
      if (!expectedHosts.has(parsedFinalUrl.hostname.toLowerCase())) {
        return result(
          link,
          'broken',
          `unexpected redirect host ${parsedFinalUrl.hostname}`,
          attempt,
          target,
          response,
        );
      }
      if (response.ok) {
        return result(link, 'healthy', `HTTP ${response.status}`, attempt, target, response);
      }
      if (response.status === 404 || response.status === 410) {
        return result(link, 'broken', `HTTP ${response.status}`, attempt, target, response);
      }
      if (INDETERMINATE_STATUSES.has(response.status)) {
        return result(
          link,
          'indeterminate',
          `HTTP ${response.status} may be access-controlled`,
          attempt,
          target,
          response,
        );
      }
      if (isRetryableStatus(response.status)) {
        if (attempt < maxAttempts) {
          await sleep(Math.min(1_000, 250 * attempt));
          continue;
        }
        return result(
          link,
          'indeterminate',
          `HTTP ${response.status} remained transient after ${attempt} attempts`,
          attempt,
          target,
          response,
        );
      }
      if (response.status >= 400 && response.status < 500) {
        return result(link, 'broken', `HTTP ${response.status}`, attempt, target, response);
      }
      return result(
        link,
        'indeterminate',
        `unexpected HTTP ${response.status}`,
        attempt,
        target,
        response,
      );
    } catch (error) {
      const reason = networkFailureReason(error);
      if (attempt < maxAttempts) {
        await sleep(Math.min(1_000, 250 * attempt));
        continue;
      }
      return result(link, 'indeterminate', `${reason} after ${attempt} attempts`, attempt, target);
    }
  }

  throw new Error('unreachable external link retry state');
}

async function checkValidatedExternalLink(
  link: MonitoredExternalLink,
  options: ExternalCheckOptions,
): Promise<ExternalLinkResult> {
  const sourceResult = await probeExternalUrl(link, link.sourceUrl, options);
  if (
    link.validationUrl === undefined ||
    sourceResult.status !== 'indeterminate' ||
    sourceResult.httpStatus === undefined ||
    !INDETERMINATE_STATUSES.has(sourceResult.httpStatus)
  ) {
    return sourceResult;
  }

  const validationResult = await probeExternalUrl(link, link.validationUrl, options);
  return {
    ...sourceResult,
    attempts: sourceResult.attempts + validationResult.attempts,
    reason: `${sourceResult.reason} at published URL; validation endpoint ${validationResult.reason}`,
    status: validationResult.status,
  };
}

export async function checkExternalLink(
  link: MonitoredExternalLink,
  options: ExternalCheckOptions = {},
): Promise<ExternalLinkResult> {
  validateExternalLinkManifest([link]);
  return checkValidatedExternalLink(link, options);
}

function compareResults(first: ExternalLinkResult, second: ExternalLinkResult): number {
  return (
    first.link.label.localeCompare(second.link.label) ||
    first.link.sourceFile.localeCompare(second.link.sourceFile) ||
    first.link.sourceUrl.localeCompare(second.link.sourceUrl)
  );
}

export async function verifyExternalLinks(
  links: readonly MonitoredExternalLink[],
  options: VerifyExternalLinksOptions = {},
): Promise<ExternalLinkSummary> {
  validateExternalLinkManifest(links);
  const concurrency = positiveInteger(options.concurrency ?? DEFAULT_CONCURRENCY, 'concurrency');
  const results: ExternalLinkResult[] = new Array(links.length);
  let nextIndex = 0;

  const workers = Array.from({ length: Math.min(concurrency, links.length) }, async () => {
    while (nextIndex < links.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await checkValidatedExternalLink(links[index], options);
    }
  });
  await Promise.all(workers);
  results.sort(compareResults);

  return {
    brokenCount: results.filter((entry) => entry.status === 'broken').length,
    healthyCount: results.filter((entry) => entry.status === 'healthy').length,
    indeterminateCount: results.filter((entry) => entry.status === 'indeterminate').length,
    results,
  };
}

export function assertExternalLinkOutcome(summary: ExternalLinkSummary): void {
  if (summary.brokenCount > 0) {
    throw new Error(
      `[verify-external-links] found ${summary.brokenCount} broken monitored link(s)`,
    );
  }
  if (summary.healthyCount === 0) {
    throw new Error(
      '[verify-external-links] inconclusive: no monitored links were confirmed healthy',
    );
  }
}

function formatResult(entry: ExternalLinkResult): string {
  const marker = entry.status === 'healthy' ? 'PASS' : entry.status === 'broken' ? 'FAIL' : 'WARN';
  const checkedUrl = entry.link.sourceUrl;
  const finalTarget =
    entry.finalUrl && entry.finalUrl !== checkedUrl ? ` -> ${entry.finalUrl}` : '';
  return `[verify-external-links] [${marker}] ${entry.link.label}: ${entry.reason}; ${entry.attempts} attempt(s); ${checkedUrl}${finalTarget}`;
}

async function main(): Promise<void> {
  const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
  await verifyExternalLinkSources(repositoryRoot, monitoredExternalLinks);
  const summary = await verifyExternalLinks(monitoredExternalLinks);

  for (const entry of summary.results) console.log(formatResult(entry));
  console.log(
    `[verify-external-links] ${summary.healthyCount} healthy, ${summary.indeterminateCount} indeterminate, ${summary.brokenCount} broken`,
  );
  assertExternalLinkOutcome(summary);
  if (summary.indeterminateCount > 0) {
    console.warn('[verify-external-links] completed with warnings');
  } else {
    console.log('[verify-external-links] passed');
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
