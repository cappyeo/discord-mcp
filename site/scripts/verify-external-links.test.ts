import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertExternalLinkOutcome,
  checkExternalLink,
  type ExternalFetch,
  type MonitoredExternalLink,
  validateExternalLinkManifest,
  verifyExternalLinkSources,
  verifyExternalLinks,
} from './verify-external-links.js';

const fixtureRoots: string[] = [];

function monitoredLink(overrides: Partial<MonitoredExternalLink> = {}): MonitoredExternalLink {
  return {
    label: 'Vendor guide',
    sourceFile: 'site/src/content/docs/guide.mdx',
    sourceUrl: 'https://docs.vendor.dev/guide',
    ...overrides,
  };
}

function response(status: number, url: string, cancel = vi.fn(async () => undefined)): Response {
  return {
    body: { cancel },
    ok: status >= 200 && status < 300,
    status,
    url,
  } as unknown as Response;
}

async function createFixture(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'discord-mcp-external-links-'));
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

describe('external link manifest', () => {
  it('rejects duplicate, insecure, placeholder, and escaping declarations', () => {
    const valid = monitoredLink();

    expect(() =>
      validateExternalLinkManifest([valid, { ...valid, label: 'Second vendor guide' }]),
    ).toThrow(/duplicate source link/);
    expect(() =>
      validateExternalLinkManifest([monitoredLink({ sourceUrl: 'http://docs.vendor.dev/guide' })]),
    ).toThrow(/HTTPS/);
    expect(() =>
      validateExternalLinkManifest([monitoredLink({ sourceUrl: 'https://example.com/guide' })]),
    ).toThrow(/placeholder/);
    expect(() =>
      validateExternalLinkManifest([monitoredLink({ sourceFile: '../outside.mdx' })]),
    ).toThrow(/relative repository path/);
  });

  it('anchors each monitored link to the exact URL published by its source file', async () => {
    const link = monitoredLink({
      validationUrl: 'https://registry.vendor.dev/packages/tool',
    });
    const root = await createFixture({
      [link.sourceFile]: `Read the [vendor guide](${link.sourceUrl}).`,
    });

    await expect(verifyExternalLinkSources(root, [link])).resolves.toBeUndefined();

    await writeFile(join(root, link.sourceFile), 'The link was removed.');
    await expect(verifyExternalLinkSources(root, [link])).rejects.toThrow(
      /does not contain.*https:\/\/docs\.vendor\.dev\/guide/,
    );
  });
});

describe('external link checks', () => {
  it('uses a redirect-following GET and cancels the response body after reading headers', async () => {
    const cancel = vi.fn(async () => undefined);
    const fetchMock = vi.fn<ExternalFetch>(async () =>
      response(200, 'https://docs.vendor.dev/current', cancel),
    );

    const result = await checkExternalLink(monitoredLink(), {
      fetch: fetchMock,
      maxAttempts: 2,
      sleep: vi.fn(async () => undefined),
      timeoutMs: 50,
    });

    expect(result).toMatchObject({
      attempts: 1,
      finalUrl: 'https://docs.vendor.dev/current',
      status: 'healthy',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://docs.vendor.dev/guide',
      expect.objectContaining({ method: 'GET', redirect: 'follow' }),
    );
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('does not let an alternate validation endpoint hide a missing published URL', async () => {
    const link = monitoredLink({ validationUrl: 'https://registry.vendor.dev/packages/tool' });
    const fetchMock = vi.fn<ExternalFetch>(async (input) => {
      const url = String(input);
      return response(url === link.sourceUrl ? 404 : 200, url);
    });

    await expect(checkExternalLink(link, { fetch: fetchMock })).resolves.toMatchObject({
      httpStatus: 404,
      status: 'broken',
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe(link.sourceUrl);
  });

  it('uses a validation endpoint only when the published URL is access-controlled', async () => {
    const link = monitoredLink({ validationUrl: 'https://registry.vendor.dev/packages/tool' });
    const fetchMock = vi.fn<ExternalFetch>(async (input) => {
      const url = String(input);
      return response(url === link.sourceUrl ? 403 : 200, url);
    });

    await expect(checkExternalLink(link, { fetch: fetchMock })).resolves.toMatchObject({
      attempts: 2,
      httpStatus: 403,
      reason: expect.stringMatching(/validation endpoint HTTP 200/),
      status: 'healthy',
    });
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
      link.sourceUrl,
      link.validationUrl,
    ]);
  });

  it('treats permanent absence as broken and access controls as indeterminate', async () => {
    const missingFetch = vi.fn<ExternalFetch>(async () =>
      response(404, 'https://docs.vendor.dev/guide'),
    );
    const forbiddenFetch = vi.fn<ExternalFetch>(async () =>
      response(403, 'https://docs.vendor.dev/guide'),
    );

    await expect(
      checkExternalLink(monitoredLink(), { fetch: missingFetch, maxAttempts: 2 }),
    ).resolves.toMatchObject({ attempts: 1, httpStatus: 404, status: 'broken' });
    await expect(
      checkExternalLink(monitoredLink(), { fetch: forbiddenFetch, maxAttempts: 2 }),
    ).resolves.toMatchObject({ attempts: 1, httpStatus: 403, status: 'indeterminate' });
    expect(missingFetch).toHaveBeenCalledOnce();
    expect(forbiddenFetch).toHaveBeenCalledOnce();
  });

  it('retries transient failures without turning an exhausted outage into a false broken link', async () => {
    const sleep = vi.fn(async () => undefined);
    const recoveredFetch = vi
      .fn<ExternalFetch>()
      .mockResolvedValueOnce(response(429, 'https://docs.vendor.dev/guide'))
      .mockResolvedValueOnce(response(200, 'https://docs.vendor.dev/guide'));

    await expect(
      checkExternalLink(monitoredLink(), {
        fetch: recoveredFetch,
        maxAttempts: 2,
        sleep,
      }),
    ).resolves.toMatchObject({ attempts: 2, status: 'healthy' });
    expect(sleep).toHaveBeenCalledOnce();

    const offlineFetch = vi.fn<ExternalFetch>(async () => {
      throw new TypeError('fetch failed');
    });
    await expect(
      checkExternalLink(monitoredLink(), {
        fetch: offlineFetch,
        maxAttempts: 2,
        sleep,
      }),
    ).resolves.toMatchObject({ attempts: 2, status: 'indeterminate' });
    expect(offlineFetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    'http://docs.vendor.dev/guide',
    'https://user:password@docs.vendor.dev/guide',
    'https://example.com/guide',
  ])('rejects an unsafe final URL after redirects: %s', async (finalUrl) => {
    const fetchMock = vi.fn<ExternalFetch>(async () => response(200, finalUrl));

    await expect(checkExternalLink(monitoredLink(), { fetch: fetchMock })).resolves.toMatchObject({
      status: 'broken',
      reason: expect.stringMatching(/unsafe final URL/),
    });
  });

  it('rejects a redirect to an unrelated HTTPS host unless the manifest allows it', async () => {
    const fetchMock = vi.fn<ExternalFetch>(async () =>
      response(200, 'https://login.vendor.dev/guide'),
    );

    await expect(checkExternalLink(monitoredLink(), { fetch: fetchMock })).resolves.toMatchObject({
      reason: expect.stringMatching(/unexpected redirect host/),
      status: 'broken',
    });

    await expect(
      checkExternalLink(monitoredLink({ allowedRedirectHosts: ['login.vendor.dev'] }), {
        fetch: fetchMock,
      }),
    ).resolves.toMatchObject({ status: 'healthy' });
  });

  it('returns a stably sorted summary independent of request completion order', async () => {
    const links = [
      monitoredLink({ label: 'Zed', sourceUrl: 'https://docs.vendor.dev/zed' }),
      monitoredLink({ label: 'Alpha', sourceUrl: 'https://docs.vendor.dev/alpha' }),
    ];
    const fetchMock = vi.fn<ExternalFetch>(async (input) => {
      const url = String(input);
      if (url.endsWith('/zed')) await Promise.resolve();
      return response(url.endsWith('/alpha') ? 410 : 200, url);
    });

    const summary = await verifyExternalLinks(links, { concurrency: 2, fetch: fetchMock });

    expect(summary).toMatchObject({ brokenCount: 1, healthyCount: 1, indeterminateCount: 0 });
    expect(summary.results.map((result) => result.link.label)).toEqual(['Alpha', 'Zed']);
  });

  it('rejects a wholly inconclusive run without failing an isolated warning', () => {
    expect(() =>
      assertExternalLinkOutcome({
        brokenCount: 0,
        healthyCount: 0,
        indeterminateCount: 2,
        results: [],
      }),
    ).toThrow(/inconclusive/);
    expect(() =>
      assertExternalLinkOutcome({
        brokenCount: 0,
        healthyCount: 1,
        indeterminateCount: 1,
        results: [],
      }),
    ).not.toThrow();
  });
});
