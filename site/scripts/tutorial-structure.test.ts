import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(__dirname, '../..');
const START_DIR = join(__dirname, '../src/content/docs/start');
const HOMEPAGE = join(ROOT, 'site/src/content/docs/index.mdx');
const NOT_FOUND_PAGE = join(ROOT, 'site/src/pages/404.astro');
const ROOT_README = join(ROOT, 'README.md');
const LLMS_SUMMARY = join(ROOT, 'site/public/llms.txt');
const SITE_README = join(ROOT, 'site/README.md');
const V1_READINESS = join(ROOT, 'site/src/content/docs/reference/v1-readiness.mdx');

const pages = [
  { file: 'index.mdx', route: '/discord-mcp/start/', order: 0, startsUnit: true },
  {
    file: 'discord-setup.mdx',
    route: '/discord-mcp/start/discord-setup/',
    order: 10,
    startsUnit: true,
  },
  {
    file: 'create-discord-bot.mdx',
    route: '/discord-mcp/start/create-discord-bot/',
    order: 11,
    startsUnit: false,
  },
  {
    file: 'local-setup.mdx',
    route: '/discord-mcp/start/local-setup/',
    order: 20,
    startsUnit: true,
  },
  {
    file: 'installation.mdx',
    route: '/discord-mcp/start/installation/',
    order: 21,
    startsUnit: false,
  },
  {
    file: 'client-setup.mdx',
    route: '/discord-mcp/start/client-setup/',
    order: 22,
    startsUnit: false,
  },
  {
    file: 'verify-setup.mdx',
    route: '/discord-mcp/start/verify-setup/',
    order: 30,
    startsUnit: true,
  },
  {
    file: 'quickstart.mdx',
    route: '/discord-mcp/start/quickstart/',
    order: 31,
    startsUnit: false,
  },
  {
    file: 'first-tool-call.mdx',
    route: '/discord-mcp/start/first-tool-call/',
    order: 32,
    startsUnit: false,
  },
  {
    file: 'activity-evidence.mdx',
    route: '/discord-mcp/start/activity-evidence/',
    order: 40,
    startsUnit: true,
  },
] as const;

function source(file: string): string {
  return readFileSync(join(START_DIR, file), 'utf8').replace(/\r\n/g, '\n');
}

function frontmatter(file: string): string {
  const match = source(file).match(/^---\n([\s\S]*?)\n---/);
  expect(match, `${file}: frontmatter`).not.toBeNull();
  return match![1]!;
}

describe('tutorial curriculum', () => {
  it('routes public first-time entrypoints through the complete tutorial', () => {
    const homepage = readFileSync(HOMEPAGE, 'utf8').replace(/\r\n/g, '\n');
    const notFound = readFileSync(NOT_FOUND_PAGE, 'utf8');
    const readme = readFileSync(ROOT_README, 'utf8');
    const llms = readFileSync(LLMS_SUMMARY, 'utf8');

    expect(homepage).toContain(
      '- text: Get a verified result\n      link: /discord-mcp/start/activity-evidence/',
    );
    expect(homepage).toContain('- text: Set up discord-mcp\n      link: /discord-mcp/start/');
    expect(homepage).toContain('[Follow the setup tutorial →](/discord-mcp/start/)');
    expect(readme).toContain(
      'href="https://cappyeo.github.io/discord-mcp/start/activity-evidence/"><strong>Get a verified result</strong>',
    );
    expect(readme).toContain(
      'href="https://cappyeo.github.io/discord-mcp/start/"><strong>Get started</strong>',
    );
    expect(notFound).toContain('href="/discord-mcp/start/">Open the tutorial</a>');
    expect(llms).toContain('First-time setup: https://cappyeo.github.io/discord-mcp/start/');
    expect(llms).toContain(
      'Verified first tool call: https://cappyeo.github.io/discord-mcp/start/quickstart/',
    );
    expect(llms).toContain(
      'First verified Discord outcome: https://cappyeo.github.io/discord-mcp/start/activity-evidence/',
    );
  });

  it('does not hard-code browser or hand-written section inventory counts', () => {
    for (const evidenceFile of [SITE_README, V1_READINESS]) {
      const evidence = readFileSync(evidenceFile, 'utf8');
      expect(evidence, evidenceFile).toContain('desktop-light/mobile-dark matrix');
      expect(evidence, evidenceFile).not.toContain('desktop-light/mobile-dark scenarios');
    }

    expect(readFileSync(SITE_README, 'utf8')).not.toMatch(
      /^ {2}- `(?:start|tools|recipes|operations|architecture|reference)\/`.*\(\d+\)$/m,
    );
  });

  it('has one ordered, explicit set of progress-tracked pages', () => {
    const actual = readdirSync(START_DIR)
      .filter((file) => file.endsWith('.mdx') && /^type: tutorial$/m.test(source(file)))
      .sort();

    expect(actual).toEqual(pages.map(({ file }) => file).sort());
    expect(new Set(pages.map(({ order }) => order)).size).toBe(pages.length);

    for (const page of pages) {
      const metadata = frontmatter(page.file);
      expect(metadata, `${page.file}: stable tutorial order`).toContain(
        `sidebar:\n  order: ${page.order}`,
      );
      expect(/^unitTitle: .+$/m.test(metadata), `${page.file}: unitTitle boundary`).toBe(
        page.startsUnit,
      );
      expect(
        source(page.file).match(/<TutorialChecklist>/g),
        `${page.file}: one checklist`,
      ).toHaveLength(1);
    }
  });

  it('keeps pagination equal to the sorted curriculum', () => {
    pages.forEach((page, index) => {
      const metadata = frontmatter(page.file);
      const previous = pages[index - 1];
      const next = pages[index + 1];

      if (previous) {
        expect(metadata, `${page.file}: previous tutorial page`).toContain(
          `prev:\n  link: ${previous.route}`,
        );
      } else {
        expect(metadata, `${page.file}: first page`).toMatch(/^prev: false$/m);
      }

      if (next) {
        expect(metadata, `${page.file}: next tutorial page`).toContain(
          `next:\n  link: ${next.route}`,
        );
      } else {
        expect(metadata, `${page.file}: final page`).toMatch(/^next: false$/m);
      }
    });
  });

  it('keeps troubleshooting outside tutorial progress', () => {
    expect(frontmatter('troubleshooting.mdx')).toMatch(/^type: guide$/m);
  });

  it('teaches the default progressive path for the first live Discord calls', () => {
    const verification = source('verify-setup.mdx');
    const quickstart = source('quickstart.mdx');
    const firstCall = source('first-tool-call.mdx');

    expect(verification).toContain('mcp_tools_search');
    expect(verification).toContain('mcp_tools_read');
    expect(verification).toContain('mcp_tools_write');

    for (const [tool, dispatcher] of [
      ['users_get_current', 'mcp_tools_read'],
      ['channels_list', 'mcp_tools_read'],
      ['messages_send', 'mcp_tools_write'],
    ] as const) {
      expect(quickstart, `${tool}: exact progressive search`).toContain(`\`query\` \`${tool}\``);
      expect(quickstart, `${tool}: risk-matched dispatcher`).toContain(`\`${dispatcher}\``);
    }

    expect(firstCall).toContain('"name": "mcp_tools_search"');
    expect(firstCall).toContain('"name": "mcp_tools_write"');
    expect(firstCall).toContain('"tool": "messages_send"');
    expect(firstCall).not.toContain('"name": "messages_send"');
  });

  it('ends with one independently verified Discord outcome', () => {
    const evidence = source('activity-evidence.mdx');

    for (const tool of [
      'build_discord_server',
      'guild_blueprint_apply',
      'guild_blueprint_evidence',
    ]) {
      expect(evidence, `${tool}: verified outcome lifecycle`).toContain(`\`${tool}\``);
    }

    expect(evidence).toContain('`MCP_DRY_RUN=false`');
    expect(evidence).toContain('[mcp_servers.discord-mcp.env]');
    expect(evidence).toContain('"MCP_WRITE_MODE": "allow"');
    expect(evidence).toContain('`evidence.activity.evidence_id`');
    expect(evidence).toContain('`status: verified`');
    expect(evidence).toContain('[connection quickstart](/discord-mcp/start/quickstart/)');
    expect(evidence).toContain('when `plan_ref` is null');
    expect(evidence).toContain('`plan_token` instead');
    expect(evidence).toContain('Enable Community manually');
    expect(evidence).not.toContain('grant **Administrator**');
  });
});
