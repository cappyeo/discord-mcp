<p align="center">
  <img src="https://raw.githubusercontent.com/cappyeo/discord-mcp/main/.github/assets/discord-mcp-banner.jpg" alt="Discord MCP - connect Discord to the Model Context Protocol" width="1200" />
</p>

<h1 align="center">Discord MCP</h1>

<p align="center">
  <a href="https://github.com/cappyeo/discord-mcp/actions/workflows/ci.yml"><img src="https://github.com/cappyeo/discord-mcp/actions/workflows/ci.yml/badge.svg" alt="CI status" /></a>
  <a href="https://www.npmjs.com/package/@discord-mcp/cli"><img src="https://img.shields.io/npm/v/%40discord-mcp%2Fcli?label=npm" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/@discord-mcp/cli"><img src="https://img.shields.io/node/v/%40discord-mcp%2Fcli" alt="Required Node.js version" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue" alt="Apache-2.0 license" /></a>
</p>

<p align="center">
  <strong>Connect any MCP-compatible AI to Discord. Do real community work safely. Verify complete guild builds.</strong><br />
  Caller-owned bot · local by default · 209 typed tools · resumable guild builds with Activity Evidence.
</p>

<p align="center">
  <a href="https://cappyeo.github.io/discord-mcp/start/activity-evidence/"><strong>Get a verified result</strong></a>
  · <a href="https://cappyeo.github.io/discord-mcp/start/"><strong>Get started</strong></a>
  · <a href="https://cappyeo.github.io/discord-mcp/tools/"><strong>Browse 209 tools</strong></a>
  · <a href="https://cappyeo.github.io/discord-mcp/showcase/live-gaming-server/"><strong>Watch live demo</strong></a>
  · <a href="https://github.com/cappyeo/discord-mcp/discussions"><strong>Join the community</strong></a>
  · <a href="https://www.npmjs.com/package/@discord-mcp/cli"><strong>View on npm</strong></a>
  · <a href="https://cappyeo.github.io/discord-mcp/"><strong>Documentation</strong></a>
</p>

## Live demo

<p align="center">
  <a href="https://cappyeo.github.io/discord-mcp/showcase/live-gaming-server/">
    <img src="https://raw.githubusercontent.com/cappyeo/discord-mcp/main/site/public/demo/live-gaming-server-build.webp" alt="Discord gaming-server onboarding and final verification, built live through discord-mcp" width="960" />
  </a>
</p>

An 87-second live walkthrough of an AI agent building a complete gaming
community from a fresh Discord server through its caller-owned bot. It covers
channels, safe role permissions, Community, Welcome Screen, onboarding,
AutoMod, Components V2 cards, and final API readback. Watch the
[full demo in the docs](https://cappyeo.github.io/discord-mcp/showcase/live-gaming-server/).

The current blueprint lifecycle adds a target-bound dry run, exact human approval,
checkpointed resume, and authenticated Activity Evidence after final Discord readback.
[Complete the verified-outcome tutorial](https://cappyeo.github.io/discord-mcp/start/activity-evidence/)
in a private test guild.

Completed it—or found the first blocker? Share a voluntary,
[credential-safe outcome report](https://github.com/cappyeo/discord-mcp/issues/new?template=verified-outcome.yml).
discord-mcp sends no report from your installation.

If you want a shortcut after a local run, `discord-mcp activity --report` prints
that fixed URL without reading or exporting the journal. It does not open a browser,
access the network, prefill or submit an issue, or expose journal records. Review every
field and submit the form yourself. The local journal contains only timestamps plus
predefined command or blueprint-stage, status, outcome, transport, and signal values;
it contains no Discord IDs, names, message content, tokens, paths, or raw errors.

## Community and feedback

Use [GitHub Discussions](https://github.com/cappyeo/discord-mcp/discussions) for setup Q&A,
recurring-workflow ideas, and redacted showcases. Start with the
[community welcome](https://github.com/cappyeo/discord-mcp/discussions/21) or watch and discuss the
[official live-build showcase](https://github.com/cappyeo/discord-mcp/discussions/22).

Never post a bot token, authorization header, client configuration, Discord ID, private server or
channel name, message content, screenshot, terminal log, plan material, evidence ID, or Activity
Evidence file. Report authorization or security issues through
[GitHub's private advisory form](https://github.com/cappyeo/discord-mcp/security/advisories/new).

## How it works

<p align="center">
  <img src="https://raw.githubusercontent.com/cappyeo/discord-mcp/main/.github/assets/discord-mcp-workflow.jpg" alt="AI clients connect to Discord through Discord MCP, with typed tools, safety controls, and observability." width="1200" />
</p>

## Quick start

Requires Node.js 22.12 or later.

```bash
# Install the MCP server
npm install -g @discord-mcp/cli

# Keep the caller-owned bot token in this terminal
export DISCORD_TOKEN="Bot YOUR_DISCORD_BOT_TOKEN"

# Verify the bot, choose its real Discord server, save a non-secret profile,
# and generate a safe Codex fragment
discord-mcp setup --profile devbot --client codex

# Verify the rest of the local configuration
discord-mcp doctor --profile devbot --online

# Explain the bot's verified guild access before a planned write
discord-mcp doctor --profile devbot --access --guild-id <GUILD_ID> --json

# Verify the real MCP path without changing Discord
discord-mcp smoke --profile devbot
```

On PowerShell, set the token before running the same `setup` and verification commands:

```powershell
$env:DISCORD_TOKEN = "Bot YOUR_DISCORD_BOT_TOKEN"
```

`setup` supports Codex, Claude Desktop, Claude Code, Google Antigravity CLI, Cursor Agent CLI, the official Grok Build CLI, legacy Gemini CLI enterprise/API-key deployments, the Cursor editor, and a generic MCP client. It sends the current token only to Discord, verifies the bot identity, chooses a guild boundary, and saves a versioned local profile containing only non-secret metadata. The generated client fragment runs a pinned `@discord-mcp/cli` package through `npx`, then `serve --profile devbot`, so it does not depend on an absolute installation or cache path. It forwards `DISCORD_TOKEN` from the caller's launch environment; neither the profile nor the generated fragment stores the token value. Antigravity, Cursor Agent, and Grok Build inherit the launch environment and keep credentials out of their MCP configuration. Gemini's compatibility fragment includes only `${DISCORD_TOKEN}` because Gemini sanitizes inherited sensitive variables unless its MCP entry explicitly opts in. A profile is locked to its first verified bot ID, so `--force` cannot silently reassign it to another bot. Use `profile list`, `profile show`, and `profile remove` for lifecycle management. The older `init` command remains available as a stateless snippet generator. See the [installation guide](https://cappyeo.github.io/discord-mcp/start/installation/) for non-interactive and client-specific setup.

For MCP clients that do not natively defer large tool catalogs, set
`MCP_TOOL_SURFACE=progressive`. The model initially receives only
the direct Discord-non-mutating `build_discord_server` architecture front door when
authorized, its direct `guild_blueprint_apply` and `guild_blueprint_evidence`
completion steps, plus `mcp_tools_search` and read, write, and destructive
dispatchers. Other tools load as compact matches on demand. A single match
already includes its schema; for multiple matches, search the selected tool's
exact name before dispatch, or use `detail: "full"` when several contracts are
needed together. The result chooses the dispatcher whose annotations match the
selected tool's risk.
`MCP_CATEGORIES` remains the authorization boundary; progressive mode does not
bypass confirmation, dry-run, audit, or other middleware.

Set `ALLOWED_GUILDS` to a comma-separated list of server IDs to enforce the
bot's guild boundary inside discord-mcp. Direct guild calls use a constant-time
check; channel, thread, webhook, invite, and guild-sticker routes are resolved
before execution and cached. Global writes and opaque interaction-token routes
that cannot prove a guild are unavailable while the allowlist is active. When
that boundary is active, bot-application routes (the five application-emoji
operations, application commands, SKUs, entitlements, and application
metadata) are exposed only when `DISCORD_EXPECTED_BOT_ID` locks the token to
one bot and they can target only that bot's application. Omit `application_id`
where supported to have the server resolve the current bot application
automatically. The
resolution caches are bounded to prevent untrusted ID churn from growing memory
without limit.
`users_list_current_user_guilds` remains a read-only discovery tool; seeing a
guild in that result does not authorize operations against it.

To run without a global install:

```bash
npx -y @discord-mcp/cli init --client cursor-cli
```

## Remote OpenAI / Codex MCP

For the OpenAI Responses API or Codex, run a bearer-protected Streamable HTTP
endpoint and place it behind an HTTPS reverse proxy:

```bash
export DISCORD_TOKEN="Bot YOUR_DISCORD_BOT_TOKEN"
export DISCORD_MCP_ACCESS_TOKEN="replace-with-a-long-random-secret"
discord-mcp serve --http --host 127.0.0.1 --port 3000
```

The endpoint is `/mcp`; send `Authorization: Bearer <DISCORD_MCP_ACCESS_TOKEN>`.
It negotiates stable MCP `2026-07-28` while retaining stateless compatibility
for 2025-era Streamable HTTP clients. Every authenticated client shares the
deployment's caller-owned Discord bot identity, so use least-privilege Discord
roles plus narrow `ALLOWED_GUILDS` and `MCP_CATEGORIES` allowlists. The
[OpenAI remote MCP guide](https://cappyeo.github.io/discord-mcp/operations/openai/)
covers HTTPS, the default 4 MiB body and 16-request in-flight ceilings,
Responses API `tool_search`/`defer_loading`, Codex progressive discovery, and
the current OAuth boundary.

## What you get

| Area | Examples |
| --- | --- |
| Messages and channels | Send, edit, pin, search, manage threads, forums, and permissions |
| Moderation and safety | Permission preflight, channel role audits, role hierarchy, bans, AutoMod, bulk actions, and audit-aware operations |
| Community operations | Members, roles, invites, onboarding, events, polls, soundboard, and voice |
| Application APIs | Slash commands, interactions, bot-owned application emojis, webhooks, and entitlements |
| Agent workflows | Tool output schemas, predictable errors, migration adapters, and client config generation |

Explore the complete, generated [tool reference](https://cappyeo.github.io/discord-mcp/tools/) and practical [recipes](https://cappyeo.github.io/discord-mcp/recipes/).

For a server-architecture request, call the directly advertised
`build_discord_server` front door when `MCP_TOOL_SURFACE=progressive`; on the `full` surface,
call its canonical name, `guild_blueprint_plan`, with one natural-language request.
The progressive alias and canonical tool use the same safety-checked planner and return the same
target-bound dry-run contract.
Request-only target resolution requires the selected caller profile to lock one
`DISCORD_EXPECTED_BOT_ID` and an `ALLOWED_GUILDS` boundary. The planner uses
`DISCORD_DEFAULT_GUILD_ID` only when that default is itself allowlisted; otherwise it resolves
the guild only when exactly one allowlisted guild exists. A multi-guild profile without an
allowlisted default requires an explicit `guild_id` and is never guessed. It selects one
verified primary template plus 0–3 bounded inspirations, compiles regenerated permissions,
onboarding, AutoMod, and Components V2 content,
then returns a target-bound dry-run. Review its operations and `approval_id`; only then pass the
unchanged caller-local `plan_ref` and returned target IDs to `guild_blueprint_apply` with `__confirm:true`.
The legacy self-contained `plan_token` remains available for compatible or portable clients. Apply is
locally checkpointed after every successful step, reconciled at each call or resume, independently
read back at completion, and never deletes an existing resource. A completed approval is
single-use: later drift requires a fresh plan. A terminal result persists authenticated Activity
Evidence and returns its ID, blueprint policy invariants, and final live-readback record. Later—even after a restart—call
`guild_blueprint_evidence` with only the same `guild_id`, `expected_bot_id`, and `plan_id` to
revalidate the current guild without a plan token, confirmation flag, or Discord mutation.
`guild_blueprint_compile` remains the lower-level read-only compiler, while
`templates_recommend` returns only the verified source portfolio. Source IDs, permissions,
overwrites, names, and descriptions never enter the trusted blueprint. See the
[safe blueprint workflow](https://cappyeo.github.io/discord-mcp/operations/blueprints/).

Community servers can contain a Discord-protected singleton AutoMod rule that cannot be deleted.
The reconciler reuses it only when its immutable trigger is unique and `creator_id` is the exact
caller-owned bot; foreign-owned or ambiguous rules block the plan without mutation.

## Built for production use

- **Safety controls** - destructive operations require explicit confirmation, Components V2 send/edit/template approvals bind to a payload hash, and guild/category allowlists constrain the bot's blast radius server-side.
- **Reliable Discord access** - retries, timeouts, rate-limit handling, and circuit breaking protect agent workflows from transient API failures.
- **Observability** - OpenTelemetry traces/metrics, optional OTLP audit logs, structured logs, and redacted audit events make operations inspectable.
- **Typed contracts** - every tool is schema-defined; public core exports, CLI flags, configuration variables, and tool metadata are regression-tested.
- **Supply-chain evidence** - npm releases are published from GitHub Actions with signed SLSA provenance.

Read the [architecture](https://cappyeo.github.io/discord-mcp/architecture/), [operations guides](https://cappyeo.github.io/discord-mcp/operations/), and [v1.0 readiness plan](https://cappyeo.github.io/discord-mcp/reference/v1-readiness/) for implementation details and current stability commitments.

## Commands

| Command | Purpose |
| --- | --- |
| `discord-mcp serve` | Start the local stdio MCP server (default), or `serve --http` for a bearer-protected Streamable HTTP endpoint. |
| `discord-mcp catalog` | Expose all 209 real tool schemas without a token; every tool call fails closed with `CATALOG_ONLY`. |
| `discord-mcp catalog --check [--json]` | Check the real local MCP catalog contract without a token, Discord request, or Discord write. This is catalog validation only—not Activity Evidence. |
| `discord-mcp setup` | Verify one caller-owned bot, save a non-secret profile, and generate its client configuration. |
| `discord-mcp activity [--report]` | Show the local, privacy-safe evidence journal; `--report` prints the optional GitHub outcome-form URL. |
| `discord-mcp update` | Check a generated Codex launcher for a newer release; apply it only with explicit `--apply`. |
| `discord-mcp profile` | List, inspect, or remove local non-secret bot profiles. |
| `discord-mcp init` | Generate a stateless MCP client configuration snippet. |
| `discord-mcp doctor` | Check Node.js, token shape, environment, optional connectivity, read-only bot/guild access (`--access`), generated Codex/Cursor/Grok launchers, and Antigravity/Gemini config for persisted credentials. |
| `discord-mcp smoke` | Verify the MCP-to-Discord path; add `--confirm-write` for a self-cleaning CRUD test, or `--confirm-template-lifecycle` to prove Guild Template inspect/diff/sync/delete and cleanup. |
| `discord-mcp migrate` | Create a migration report from a supported Discord MCP setup. |

Run `discord-mcp --help` or see the full [CLI reference](https://cappyeo.github.io/discord-mcp/reference/cli/) for flags and examples.

### Registry-safe schema discovery

`discord-mcp catalog` is a credential-free stdio server for MCP directories,
security review, and contract inspection. It advertises the same 209 schemas as
the full server, never reads a bot token, never contacts Discord, and returns
`CATALOG_ONLY` for every `tools/call`. It is not an operational Discord server;
use `discord-mcp serve` with your caller-owned bot when an AI agent should act.

To validate that the installed package exposes the real catalog contract, run:

```bash
discord-mcp catalog --check
discord-mcp catalog --check --json
```

`catalog --check` is intentionally credential-free and local: it needs no Discord
token, does not read `DISCORD_TOKEN`, performs no Discord request or write (and no
other network request), and does not count as Activity Evidence. A successful check
only proves catalog discovery; continue to [set up a caller-owned bot](https://cappyeo.github.io/discord-mcp/start/)
to reach the first verified Discord outcome.

With `--json`, the result uses schema `discord-mcp.catalog-check.v1` and reports the
expected 209 tools, 6 static resources, `execution_guard: "CATALOG_ONLY"`,
`credentials_required: false`, `discord_execution: "disabled"`, and
`activity_evidence_created: false`. It proves the installed catalog contract only;
it does not prove that an AI host or a live Discord connection is configured.

The repository's root `Dockerfile` intentionally defaults to this catalog-only
mode so automated registry scanners can inspect the project safely. Images built
from source can explicitly run `serve` instead, but the caller must supply their
own `DISCORD_TOKEN` and safety configuration.

## Packages

| Package | Use it when |
| --- | --- |
| [@discord-mcp/cli](https://www.npmjs.com/package/@discord-mcp/cli) | You want to run Discord MCP from an AI client or terminal. |
| [@discord-mcp/core](https://www.npmjs.com/package/@discord-mcp/core) | You are building an integration on the typed Discord MCP tool and server primitives. |

The CLI runs on macOS, Linux, and Windows. Its executable is always `discord-mcp`.

## Migrate an existing setup

`discord-mcp` includes migration adapters for established community projects, including PaSympa, quadslab, and discord-ops. Start with:

```bash
discord-mcp migrate --list
```

Then use `discord-mcp migrate --from <adapter> --source <path>` to generate a tool-by-tool mapping report. The [migration guides](https://cappyeo.github.io/discord-mcp/migrate/) explain each adapter and its limits.

## Develop locally

```bash
pnpm install
pnpm build
pnpm test
```

The repository is a pnpm workspace. For a real Discord smoke test, set `DISCORD_TOKEN` and run `node packages/mcp-server/dist/cli.js`; the [MCP Inspector](https://github.com/modelcontextprotocol/inspector) is useful for verifying `tools/list` interactively.

Maintainers can use the
[AI host activation matrix](https://cappyeo.github.io/discord-mcp/reference/activation-matrix/)
to preflight and sequentially run three live trials for each of Codex, Claude
Code, Antigravity CLI, Cursor Agent, and Grok Build against one exact release
build. A separate read-only verifier consumes the five private campaign
attestations and revalidates all 15 original trials without launching models or
writing to Discord.

## Project status

`discord-mcp` is pre-1.0. This source tree targets **v0.24.0** plus an unreleased 209-tool increment. Its core exports, CLI surface, environment schema, and tool registry are covered by contract tests; publication is gated on independently verified real-server evidence appropriate to the exact tag commit. See the [GitHub releases](https://github.com/cappyeo/discord-mcp/releases), [changelog](https://cappyeo.github.io/discord-mcp/reference/changelog/), and [v1.0 readiness checklist](https://cappyeo.github.io/discord-mcp/reference/v1-readiness/) before depending on an unstable surface.

Help validate v1.0: if you have not authored discord-mcp or its documentation,
follow the [external documentation review](https://cappyeo.github.io/discord-mcp/reference/external-documentation-review/)
using only the public docs and package, then
[submit a structured report](https://github.com/cappyeo/discord-mcp/issues/new?template=documentation-review.yml).
Use a caller-owned bot in a private test server. Never include a bot token,
client configuration, webhook credential, or unredacted Discord identifier in
the report.

## License

The current source is licensed under the [Apache License 2.0](LICENSE). You
may use, modify, distribute, and sell it subject to that license's terms.

Published releases through `v0.23.0` remain available under the MIT License
included with those releases. Source revisions previously made available under
the Functional Source License remain governed by that license.

Community participation and project support are governed by the
[Acceptable Use Policy](https://github.com/cappyeo/discord-mcp/blob/main/ACCEPTABLE-USE.md),
which does not modify the software license. Contributions are accepted under
Apache-2.0; see [Contributing](CONTRIBUTING.md).
