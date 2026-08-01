/**
 * Shared types for the four MCP client snippet generators.
 *
 * Each generator consumes a {@link SnippetConfig} (the user's choices —
 * server path, token, gateway flag, extra env) and emits a {@link Snippet}
 * containing the rendered config text, the canonical filesystem path
 * where it should land, and human-readable merge instructions.
 *
 * `init` collects the answers, picks the right generator from
 * {@link ClientGenerator}.id, and either prints the snippet or writes it
 * to the path requested by `--output`.
 */

/**
 * User-supplied inputs to a generator.
 *
 * `serverPath` + `serverArgs` together form the `command` + `args` keys
 * in the standard MCP server config (e.g. `command: "node",
 * args: ["/abs/path/cli.js"]`). When the project is published on npm a
 * portable alternative is `serverPath: "npx"` + `serverArgs:
 * ["@discord-mcp/cli"]` — generators don't enforce one or the other,
 * they just wire whatever the caller provides.
 *
 * `discordToken` is the literal value placed in `env.DISCORD_TOKEN`.
 * Callers that don't want to leak a real secret should pass a
 * placeholder like `${env:DISCORD_TOKEN}` so the user can resolve it
 * via their shell environment.
 *
 * `gateway` adds `--gateway` to the args when true. `envVars` is merged
 * into the `env` object alongside `DISCORD_TOKEN` (e.g. OTEL_*, MCP_AUDIT_*).
 */
export interface SnippetConfig {
  readonly serverPath: string;
  readonly serverArgs?: readonly string[];
  readonly discordToken: string;
  readonly gateway?: boolean;
  readonly envVars?: Readonly<Record<string, string>>;
}

/**
 * The rendered output of a generator.
 *
 * `format` distinguishes JSON (current — all 4 clients converged on the
 * Anthropic MCP config schema) from TOML (reserved for future clients).
 *
 * `content` is the literal text the user pastes / the file `init`
 * writes. Always ends with a newline so editors don't whine.
 *
 * `configFilePath` is documented (NOT auto-written by `init`) so users
 * with non-standard install layouts can adapt. `instructions` is
 * `details` material — printed under the summary in pretty mode.
 */
export interface Snippet {
  readonly format: 'json' | 'toml';
  readonly content: string;
  readonly configFilePath: string;
  readonly instructions: string;
}

/**
 * Plug-in shape for each MCP client.
 *
 * `id` is the stable identifier passed via `--client <id>`. Must be
 * kebab-case ASCII so it works across shells. `displayName` is rendered
 * in human-facing output.
 */
export interface ClientGenerator {
  readonly id: string;
  readonly displayName: string;
  generate(cfg: SnippetConfig): Snippet;
}
