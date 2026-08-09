# site - discord-mcp documentation

Astro Starlight site published at <https://cappyeo.github.io/discord-mcp/>.

## Local development

```bash
pnpm --filter site dev
```

Opens at `http://localhost:4321/discord-mcp/`. The `predev` hook auto-runs
`generate-tools` so the `/tools/*` reference reflects current code.

## Build

```bash
pnpm --filter site build
```

Output goes to `site/dist/`. Pagefind search index is built in
`site/dist/pagefind/` automatically (Starlight 0.37 default).

```bash
pnpm --filter site preview
```

Serves `dist/` locally on port 4321 - useful to verify Pagefind search
before deploying.

## Regenerate tool reference

```bash
pnpm --filter site generate-tools
```

Reads `__toolMetadata` static from `@discord-mcp/core` exports and emits
one MDX per tool plus 30 category index pages plus a top-level index
into `site/src/content/docs/tools/`. Runs automatically before `dev` and
`build`.

## Structure

- `astro.config.ts` - Starlight config (sidebar, base path)
- `src/content/docs/` - all MDX content
  - `start/` - quickstart pages (5)
  - `tools/` - auto-generated tool reference (202 tools + 31 categories + 1 index)
  - `recipes/` - cookbook recipes (6)
  - `operations/` - operator guides (4)
  - `architecture/` - deep-dives (9)
  - `reference/` - CLI, config, API, changelog (5)
- `src/components/docs/` - reusable MDX building blocks
  - `DocsCardGrid.astro` - data-driven cards for section hubs
  - `ClientTabs.astro` - synchronized Claude Desktop / Claude Code / Cursor / generic tabs
- `scripts/generate-tool-docs.ts` - tool MDX generator

## Authoring hand-written docs

Keep product facts close to their source: generated tool docs come only from
`generate-tool-docs.ts`, while hand-written guides compose Starlight components
and the shared MDX building blocks in `src/components/docs/`.

- Use `DocsCardGrid` for a section's primary navigation: MDX supplies an array
  of `{ title, description, href }` data and the component owns the visual
  markup.
- Use `ClientTabs` for any client-specific instructions. Supply named slots
  (`claude-desktop`, `claude-code`, `cursor`, `generic`) so the selected tab
  stays synchronized across pages.
- Keep guides and references separate: `operations/configure.mdx` explains
  deployment decisions, while `reference/config/` holds the exact
  environment-variable contract grouped by concern. Update both the reference
  and the hand-authored sidebar when a runtime setting changes.
- Verify every documentation change with `pnpm --filter site test` and
  `pnpm --filter site build` before publishing.

## GitHub Pages setup (operators)

After merging Plan 10:

1. Repo Settings → Pages → Source: **GitHub Actions**
2. Push to `main` triggers `.github/workflows/docs.yml`
3. First successful deploy publishes to <https://cappyeo.github.io/discord-mcp/>

The workflow only runs on push to `main`. PR-mode CI builds the site
as a smoke test (no deploy).

## Custom domain (optional)

To use a custom domain, drop a `CNAME` file into `site/public/`:

```
docs.your-domain.com
```

Then configure DNS (CNAME record pointing to `cappyeo.github.io`) and
update repo Settings → Pages → Custom domain.
