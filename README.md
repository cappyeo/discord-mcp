<p align="center">
  <img src="https://raw.githubusercontent.com/cappyeo/discord-mcp/main/.github/assets/discord-mcp-banner.jpg" alt="Discord MCP - connect Discord to the Model Context Protocol" width="1200" />
</p>

<h1 align="center">Discord MCP</h1>

**An open-source Model Context Protocol (MCP) server for Discord.** Connect Claude, Codex, Cursor, and other MCP-compatible AI clients to your own Discord bot. Manage messages, channels, roles, moderation, and server setup through 222 typed tools.

[![CI status](https://github.com/cappyeo/discord-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/cappyeo/discord-mcp/actions/workflows/ci.yml) [![npm version](https://img.shields.io/npm/v/%40discord-mcp%2Fcli?label=npm)](https://www.npmjs.com/package/@discord-mcp/cli) [![Required Node.js version](https://img.shields.io/node/v/%40discord-mcp%2Fcli)](https://www.npmjs.com/package/@discord-mcp/cli) [![Apache-2.0 license](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

<p align="center">
  <a href="https://cappyeo.github.io/discord-mcp/start/"><img src="https://raw.githubusercontent.com/cappyeo/discord-mcp/main/.github/assets/readme/button-get-started.svg" alt="Get started" width="184" height="48" /></a>
  <a href="https://cappyeo.github.io/discord-mcp/tools/"><img src="https://raw.githubusercontent.com/cappyeo/discord-mcp/main/.github/assets/readme/button-browse-tools.svg" alt="Browse tools" width="184" height="48" /></a>
  <a href="https://cappyeo.github.io/discord-mcp/showcase/live-gaming-server/"><img src="https://raw.githubusercontent.com/cappyeo/discord-mcp/main/.github/assets/readme/button-watch-demo.svg" alt="Watch live demo" width="184" height="48" /></a>
</p>

<h2 align="center"><img src="https://raw.githubusercontent.com/cappyeo/discord-mcp/main/.github/assets/readme/section-demo.svg" alt="Live demo" width="720" /></h2>

<p align="center">
  <a href="https://cappyeo.github.io/discord-mcp/showcase/live-gaming-server/">
    <img src="https://raw.githubusercontent.com/cappyeo/discord-mcp/main/site/public/demo/live-gaming-server-build.webp" alt="Discord gaming-server onboarding and final verification, built live through discord-mcp" width="960" />
  </a>
</p>

Watch an AI agent build a gaming community: channels, roles, onboarding, AutoMod, and final verification. [Play the 87-second video](https://cappyeo.github.io/discord-mcp/showcase/live-gaming-server/) · [Download MP4](https://cappyeo.github.io/discord-mcp/demo/live-gaming-server-build.mp4).

<h2 align="center"><img src="https://raw.githubusercontent.com/cappyeo/discord-mcp/main/.github/assets/readme/section-capabilities.svg" alt="What can it do?" width="720" /></h2>

<p align="center">
  <img src="https://raw.githubusercontent.com/cappyeo/discord-mcp/main/.github/assets/discord-mcp-workflow.jpg" alt="AI clients connect to Discord through Discord MCP, with typed tools, safety controls, and observability." width="1200" />
</p>

| You want to… | Discord MCP provides |
| --- | --- |
| Run a community | Messages, threads, forums, roles, events, polls, and onboarding |
| Moderate a server | Permission checks, role audits, bans, and AutoMod |
| Build a server from a prompt | A blueprint to preview and approve, resumable execution, and final Discord readback |
| Extend your bot | Slash commands, interactions, webhooks, and application emojis |
| Improve an existing server | Preview bounded edits, inspect member access, preserve IDs, resume, and restore selected configuration changes |
| Read a conversation with sources | Gather bounded channel/thread history and replies with Discord citations and explicit coverage |
| Run a background workflow | Start a durable sequence, inspect progress, cancel cooperatively, and resume after reviewing checkpoints |

For a complete server build, <a href="https://cappyeo.github.io/discord-mcp/start/activity-evidence/"><strong>Get a verified result</strong></a>: review the plan, approve it, then inspect Activity Evidence from the final readback.

<h2 align="center"><img src="https://raw.githubusercontent.com/cappyeo/discord-mcp/main/.github/assets/readme/section-quick-start.svg" alt="Quick start" width="720" /></h2>

Requires **Node.js 22.12+** and [your own Discord bot](https://cappyeo.github.io/discord-mcp/start/create-discord-bot/) installed in a server you control. Works on Windows, macOS, and Linux.

```bash
npm install -g @discord-mcp/cli
```

Set the bot token in your terminal:

```bash
# macOS / Linux
export DISCORD_TOKEN="Bot YOUR_DISCORD_BOT_TOKEN"
```

```powershell
# Windows PowerShell
$env:DISCORD_TOKEN = "Bot YOUR_DISCORD_BOT_TOKEN"
```

Generate a client configuration and verify the connection (Codex example):

```bash
discord-mcp setup --profile devbot --client codex
discord-mcp doctor --profile devbot --online
discord-mcp smoke --profile devbot
```

`setup` verifies your bot, selects a server boundary, and saves a non-secret profile. **Apply the generated configuration to your AI client**; setup does not edit it for you. Launch the client with `DISCORD_TOKEN` available in its environment. The smoke check above does not change Discord.

See [client setup](https://cappyeo.github.io/discord-mcp/start/client-setup/) for Claude, Codex, Cursor, VS Code/GitHub Copilot, Windsurf, Cline, Roo Code, Continue, Zed, OpenCode, Devin Local, and other clients, plus desktop-app token setup. New to MCP? <a href="https://cappyeo.github.io/discord-mcp/start/"><strong>Get started</strong></a> with the complete tutorial.

<h2 align="center"><img src="https://raw.githubusercontent.com/cappyeo/discord-mcp/main/.github/assets/readme/section-safety.svg" alt="Safety and deployment" width="720" /></h2>

- **Your bot, your permissions.** Guild and tool-category allowlists constrain access. Keep bot tokens out of client config files and source control.
- **Preview first.** Guided `setup` defaults to `MCP_WRITE_MODE=preview`, which blocks all mutations. Direct `serve` defaults to allowing ordinary writes; `MCP_DRY_RUN` covers only confirmation-gated destructive tools. See [safety controls](https://cappyeo.github.io/discord-mcp/reference/config/safety/) before enabling writes.
- **Local by default.** Run over stdio, or self-host a bearer-protected Streamable HTTP endpoint behind HTTPS. See [remote MCP setup](https://cappyeo.github.io/discord-mcp/operations/openai/).

<h2 align="center"><img src="https://raw.githubusercontent.com/cappyeo/discord-mcp/main/.github/assets/readme/section-docs.svg" alt="Documentation" width="720" /></h2>

| Next step | Guide |
| --- | --- |
| Find a tool or workflow | [Tool reference](https://cappyeo.github.io/discord-mcp/tools/) · [Recipes](https://cappyeo.github.io/discord-mcp/recipes/) |
| Configure and operate | [Configuration](https://cappyeo.github.io/discord-mcp/operations/configure/) · [CLI commands](https://cappyeo.github.io/discord-mcp/reference/cli/) |
| Build or migrate a server | [Blueprint workflow](https://cappyeo.github.io/discord-mcp/operations/blueprints/) · [Migration guides](https://cappyeo.github.io/discord-mcp/migrate/) |
| Improve an existing server | [Change plans and member access](https://cappyeo.github.io/discord-mcp/operations/server-changes/) |
| Read conversations or run background work | [Cited context](https://cappyeo.github.io/discord-mcp/operations/conversation-context/) · [Durable workflows](https://cappyeo.github.io/discord-mcp/operations/workflows/) |
| Build an integration | [Architecture](https://cappyeo.github.io/discord-mcp/architecture/) · [@discord-mcp/core](https://www.npmjs.com/package/@discord-mcp/core) |

<details>
<summary>Inspect the tool catalog without a bot token</summary>

```bash
discord-mcp catalog --check
discord-mcp catalog --check --json
```

Validates the real local MCP catalog with no token, no Discord or other network request, and no Discord write. This is not Activity Evidence and does not verify a live connection. Continue with [setup](https://cappyeo.github.io/discord-mcp/start/) to use your bot. See the [catalog contract](https://cappyeo.github.io/discord-mcp/start/installation/#optional-catalog-check) for JSON output. The Docker image defaults to catalog-only mode; bot operations require `serve` and your own credentials.

</details>

<h2 align="center"><img src="https://raw.githubusercontent.com/cappyeo/discord-mcp/main/.github/assets/readme/section-community.svg" alt="Project and community" width="720" /></h2>

**Pre-1.0.** Check [releases](https://github.com/cappyeo/discord-mcp/releases) and [v1.0 readiness](https://cappyeo.github.io/discord-mcp/reference/v1-readiness/) for current stability commitments.

Ask questions in [Discussions](https://github.com/cappyeo/discord-mcp/discussions), share a voluntary [outcome report](https://github.com/cappyeo/discord-mcp/issues/new?template=verified-outcome.yml), or follow the [external documentation review](https://cappyeo.github.io/discord-mcp/reference/external-documentation-review/) and [submit feedback](https://github.com/cappyeo/discord-mcp/issues/new?template=documentation-review.yml). Never include a bot token, client configuration, private Discord data, or unredacted logs. Report vulnerabilities [privately](https://github.com/cappyeo/discord-mcp/security/advisories/new).

To develop locally, run `pnpm install`, `pnpm build`, then `pnpm test`. See [Contributing](CONTRIBUTING.md); use [MCP Inspector](https://github.com/modelcontextprotocol/inspector) to inspect tool discovery.

Licensed under [Apache-2.0](LICENSE). Earlier releases retain their included licenses. The [Acceptable Use Policy](ACCEPTABLE-USE.md) governs community participation and support without changing the software license.
