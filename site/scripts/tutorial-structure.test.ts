import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const START_DIR = join(__dirname, '../src/content/docs/start');

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
});
