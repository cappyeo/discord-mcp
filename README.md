<p align="center">
  <img src="https://raw.githubusercontent.com/cappyeo/discord-mcp/main/.github/assets/discord-mcp-banner.jpg" alt="Discord MCP - connect Discord to the Model Context Protocol" width="1200" />
</p>

<h1 align="center">discord-mcp</h1>

<p align="center">
  <a href="https://github.com/cappyeo/discord-mcp/actions/workflows/ci.yml"><img src="https://github.com/cappyeo/discord-mcp/actions/workflows/ci.yml/badge.svg" alt="CI status" /></a>
  <a href="https://www.npmjs.com/package/@discord-mcp/cli"><img src="https://img.shields.io/npm/v/%40discord-mcp%2Fcli?label=npm" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/@discord-mcp/cli"><img src="https://img.shields.io/node/v/%40discord-mcp%2Fcli" alt="Required Node.js version" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/cappyeo/discord-mcp" alt="MIT license" /></a>
</p>

<p align="center">
  <strong>Connect your AI client to Discord through a local, typed, production-ready MCP server.</strong><br />
  192 tools for messages, moderation, members, channels, commands, webhooks, and more.
</p>

<p align="center">
  <a href="https://cappyeo.github.io/discord-mcp/start/quickstart/"><strong>Quickstart</strong></a>
  · <a href="https://cappyeo.github.io/discord-mcp/tools/"><strong>Browse 192 tools</strong></a>
  · <a href="https://www.npmjs.com/package/@discord-mcp/cli"><strong>View on npm</strong></a>
  · <a href="https://cappyeo.github.io/discord-mcp/"><strong>Documentation</strong></a>
</p>

## How it works

<p align="center">
  <img src="https://raw.githubusercontent.com/cappyeo/discord-mcp/main/.github/assets/discord-mcp-workflow.svg" alt="AI client connects to discord-mcp over stdio, then discord-mcp connects to Discord with confirmation gates, reliability controls, and observability." width="1200" />
</p>

## Quick start

Requires Node.js 22.12 or later.

```bash
# Install the MCP server
npm install -g @discord-mcp/cli

# Generate a client-specific configuration fragment for Codex
discord-mcp init --client codex

# Verify your Discord token and local configuration
export DISCORD_TOKEN="Bot YOUR_DISCORD_BOT_TOKEN"
discord-mcp doctor --online
```

On PowerShell, set the token with:

```powershell
$env:DISCORD_TOKEN = "Bot YOUR_DISCORD_BOT_TOKEN"
```

`init` supports Codex, Claude Desktop, Claude Code, Cursor, and a generic MCP client. It prints a complete configuration fragment; merge it into an existing client configuration rather than overwriting it. The Codex fragment forwards `DISCORD_TOKEN` from its launch environment instead of storing the token in `~/.codex/config.toml`. See the [installation guide](https://cappyeo.github.io/discord-mcp/start/installation/) for non-interactive and client-specific setup.

To run without a global install:

```bash
npx -y @discord-mcp/cli init --client cursor
```

## What you get

| Area | Examples |
| --- | --- |
| Messages and channels | Send, edit, pin, search, manage threads, forums, and permissions |
| Moderation and safety | Bans, role changes, AutoMod rules, bulk actions, and audit-aware operations |
| Community operations | Members, roles, invites, onboarding, events, polls, soundboard, and voice |
| Application APIs | Slash commands, interactions, application emojis, webhooks, and entitlements |
| Agent workflows | Tool output schemas, predictable errors, migration adapters, and client config generation |

Explore the complete, generated [tool reference](https://cappyeo.github.io/discord-mcp/tools/) and practical [recipes](https://cappyeo.github.io/discord-mcp/recipes/).

## Built for production use

- **Safety controls** - destructive operations require explicit confirmation and can be governed by category-level controls.
- **Reliable Discord access** - retries, timeouts, rate-limit handling, and circuit breaking protect agent workflows from transient API failures.
- **Observability** - OpenTelemetry traces and metrics, structured logs, and audit events make operations inspectable.
- **Typed contracts** - every tool is schema-defined; public core exports, CLI flags, configuration variables, and tool metadata are regression-tested.
- **Supply-chain evidence** - npm releases are published from GitHub Actions with signed SLSA provenance.

Read the [architecture](https://cappyeo.github.io/discord-mcp/architecture/), [operations guides](https://cappyeo.github.io/discord-mcp/operations/), and [v1.0 readiness plan](docs/v1.0.0-readiness.md) for implementation details and current stability commitments.

## Commands

| Command | Purpose |
| --- | --- |
| `discord-mcp serve` | Start the stdio MCP server. This is the default command. |
| `discord-mcp init` | Generate an MCP client configuration snippet. |
| `discord-mcp doctor` | Check Node.js, token format, environment, audit configuration, and optional network connectivity. |
| `discord-mcp migrate` | Create a migration report from a supported Discord MCP setup. |

Run `discord-mcp --help` or see the full [CLI reference](https://cappyeo.github.io/discord-mcp/reference/cli/) for flags and examples.

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

## Project status

`discord-mcp` is pre-1.0. The current public release is **v0.13.2**; its core exports, CLI surface, environment schema, and 192-tool registry are covered by contract tests. See the [changelog](https://cappyeo.github.io/discord-mcp/reference/changelog/) and [v1.0 readiness checklist](docs/v1.0.0-readiness.md) before depending on an unstable surface.

## License

[MIT](LICENSE)
