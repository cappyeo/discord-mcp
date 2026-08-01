/**
 * Static template registry.
 *
 * These were previously discovered with `readdir` against a path derived from
 * `import.meta.url`. That works under vitest (which runs from `src/`) and fails
 * in the published package: tsdown emits a single `dist/index.js`, the `.json`
 * files are not bundled, `files: ["dist"]` excludes them from the tarball, and
 * the computed path resolves to `packages/mcp-core/tools/...` which does not
 * exist. Every consumer's `resources/list` threw and
 * `components_v2_send_from_template` failed for all five templates, while the
 * whole test suite stayed green.
 *
 * Static imports make the bundler inline the JSON, so there is no filesystem
 * access and no path to resolve at runtime. Adding a template means adding a
 * line here - which is a feature: a template that is not registered is also
 * not silently half-shipped.
 */
import announcement from './announcement.json' with { type: 'json' };
import incidentStatus from './incident_status.json' with { type: 'json' };
import pollResults from './poll_results.json' with { type: 'json' };
import releaseNotes from './release_notes.json' with { type: 'json' };
import welcomeCard from './welcome_card.json' with { type: 'json' };

export const TEMPLATES: Readonly<Record<string, unknown>> = Object.freeze({
  announcement,
  incident_status: incidentStatus,
  poll_results: pollResults,
  release_notes: releaseNotes,
  welcome_card: welcomeCard,
});

export const TEMPLATE_NAMES: readonly string[] = Object.freeze(Object.keys(TEMPLATES).sort());
