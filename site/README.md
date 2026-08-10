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

## Rendered artifact audits

Install the lockfile-pinned Chromium headless shell once, build the site, then run the audit:

```bash
pnpm --filter site exec playwright install --only-shell chromium
pnpm --filter site build
pnpm --filter site test:links
pnpm --filter site test:browser
```

The link audit parses every generated HTML document and checks all same-origin `href`, `src`,
`poster`, and meta-refresh targets against the exact, case-sensitive `site/dist` artifact. Internal
fragments must resolve to an `id` or legacy anchor in their target document. External URLs remain
outside this offline gate.

The browser audit serves the same artifact on a loopback-only ephemeral port and checks the
desktop-light/mobile-dark matrix across the homepage, first-time entry, onboarding, search,
generated tool docs, migration, and the live demo. It fails on any axe WCAG A/AA or best-practice
violation, same-origin HTTP failure, browser runtime error, missing semantic landmark, broken
representative interaction, or horizontal viewport overflow. It also blocks every serious or
critical axe `incomplete` result. When axe cannot resolve
text contrast through CSS variables, translucent layers, gradients, or clipped content, the audit
independently composites solid background stacks and samples complex backgrounds from the rendered
pixels. An unknown target or any sample below its WCAG AA threshold fails the build; there is no
rule-wide contrast exception. A rendered canary proves on every run that the verifier accepts an AA
gradient case and rejects an intentional sub-AA case.

GitHub Actions runs the full link audit, then installs Chromium with its system dependencies and runs
the browser audit before the Pages artifact can be uploaded. Pull requests affecting the site,
generated tool source, lockfile, or docs workflow run the same build-and-audit gate without
deploying.

## Regenerate tool reference

```bash
pnpm --filter site generate-tools
```

Reads `__toolMetadata` static from `@discord-mcp/core` exports and emits
one MDX page per tool, one index per registered category, and a top-level
index into `site/src/content/docs/tools/`. Runs automatically before `dev`
and `build`.

## Structure

- `astro.config.ts` - Starlight config (sidebar, base path)
- `src/content/docs/` - all MDX content
  - `start/` - guided setup and troubleshooting
  - `tools/` - auto-generated tool and category reference
  - `recipes/` - cookbook workflows
  - `operations/` - operator deployment and safety guides
  - `architecture/` - design deep-dives
  - `reference/` - CLI, config, API, changelog, and release evidence
- `src/components/docs/` - reusable MDX building blocks
  - `DocsCardGrid.astro` - data-driven cards for section hubs
  - `ClientTabs.astro` - synchronized Claude Desktop / Claude Code / Cursor / generic tabs
- `scripts/generate-tool-docs.ts` - tool MDX generator
- `scripts/verify-dist-links.ts` - full generated-route, asset, and fragment integrity gate
- `scripts/audit-rendered-docs.ts` - real-browser semantic, accessibility, interaction, and layout gate
- `scripts/rendered-contrast.ts` - tested color parsing, compositing, and WCAG contrast math used by the browser gate

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
  `pnpm --filter site build` before publishing. Run `pnpm --filter site test:links` after every build,
  and run `pnpm --filter site test:browser` for any change that can affect rendered content,
  navigation, interaction, or layout.

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
