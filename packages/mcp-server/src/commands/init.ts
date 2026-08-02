/**
 * `discord-mcp init` - Plan 9 Phase D.
 *
 * Replaces the Phase A placeholder. Bootstraps an MCP client config
 * snippet that the user can paste into their client's config file (or
 * have us write directly via `--output`).
 *
 * Flow:
 *   1. Resolve which client (`--client <id>` OR interactive choice OR
 *      'generic' as the silent default for non-interactive runs).
 *   2. Resolve the Discord token (`--token` OR the
 *      `${env:DISCORD_TOKEN}` placeholder so users don't accidentally bake a
 *      real secret into a committed file).
 *   3. Resolve the gateway flag (`--gateway` OR interactive yes/no OR
 *      false by default).
 *   4. Validate the advertised tool surface (`full` by default, or the
 *      opt-in `progressive` search + risk-specific dispatcher surface).
 *   5. Validate and normalize the optional server-side guild allowlist. With
 *      `--discover-guilds`, verify the current bot identity, enumerate its
 *      real guilds, and select or validate the allowlist before generation.
 *   6. Pick a serverPath/serverArgs strategy. We use the current Node
 *      binary + the resolved CLI script - works for any installation
 *      (workspace, global npm, npx) at the cost of an absolute path
 *      that may need editing if the user later moves the project.
 *      The output explicitly tells the user how to switch to
 *      `npx @discord-mcp/cli` for portable distribution.
 *   7. Generate the snippet via the chosen ClientGenerator.
 *   8. Either write to `--output <path>` (with `--force` for overwrite
 *      protection) or print to stdout / structured payload.
 *
 * Token redaction: in pretty mode the snippet text contains whatever
 * `--token` was passed - including raw secrets. The CLI flag's help
 * text warns about this. The placeholder default avoids the issue
 * entirely. We do NOT echo the token in any other log line.
 */
import { existsSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALL_GENERATORS } from '../lib/client-snippets/index.js';
import { emitResult } from '../lib/output.js';
import { askChoice, askYesNo, isInteractive } from '../lib/prompt.js';

export interface InitOptions {
  token?: string;
  client?: string;
  output?: string;
  force?: boolean;
  gateway?: boolean;
  toolSurface?: string;
  allowedGuilds?: string;
  discoverGuilds?: boolean;
  json?: boolean;
}

// Literal placeholder string used when the user opts out of supplying a
// real token. Clients that support env-var interpolation (Claude Desktop,
// Cursor, etc.) will resolve this at startup; clients that don't will
// flag it as a missing token so the user notices.
//
// biome-ignore lint/suspicious/noTemplateCurlyInString: literal placeholder for MCP client env interpolation
const TOKEN_PLACEHOLDER = '${env:DISCORD_TOKEN}';
const DISCORD_API_DEFAULT = 'https://discord.com/api/v10';
const DISCORD_REQUEST_TIMEOUT_MS = 5000;
const SNOWFLAKE = /^\d{17,20}$/;
const ADMINISTRATOR_PERMISSION = 8n;

interface DiscordSetupGuild {
  readonly id: string;
  readonly name: string;
  readonly administrator: boolean;
}

interface DiscordSetupDiscovery {
  readonly bot: {
    readonly id: string;
    readonly username: string;
  };
  readonly guilds: DiscordSetupGuild[];
}

function safeDisplay(value: string): string {
  return value.replace(/[\p{Cc}\p{Cf}]/gu, ' ').trim();
}

function discordAuthHeader(token: string): string {
  return token.startsWith('Bot ') ? token : `Bot ${token}`;
}

async function discordGet(path: string, token: string): Promise<unknown> {
  const baseUrl = process.env.DISCORD_API_BASE_URL ?? DISCORD_API_DEFAULT;
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'GET',
    headers: {
      Authorization: discordAuthHeader(token),
      'User-Agent': 'discord-mcp-init (https://github.com/cappyeo/discord-mcp)',
    },
    signal: AbortSignal.timeout(DISCORD_REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    if (response.status === 401) throw new Error('Discord rejected DISCORD_TOKEN (401)');
    if (response.status === 403) throw new Error('Discord denied access for this bot (403)');
    if (response.status === 429) throw new Error('Discord rate-limited guild discovery (429)');
    throw new Error(`Discord returned HTTP ${response.status}`);
  }

  try {
    return await response.json();
  } catch {
    throw new Error('Discord returned an invalid JSON response');
  }
}

function parseGuild(raw: unknown): DiscordSetupGuild {
  if (raw === null || typeof raw !== 'object') {
    throw new Error('Discord returned an invalid guild entry');
  }
  const guild = raw as { id?: unknown; name?: unknown; permissions?: unknown };
  if (typeof guild.id !== 'string' || !SNOWFLAKE.test(guild.id)) {
    throw new Error('Discord returned a guild with an invalid id');
  }
  if (typeof guild.name !== 'string' || typeof guild.permissions !== 'string') {
    throw new Error(`Discord returned incomplete metadata for guild ${guild.id}`);
  }

  let permissions: bigint;
  try {
    permissions = BigInt(guild.permissions);
  } catch {
    throw new Error(`Discord returned invalid permissions for guild ${guild.id}`);
  }

  return {
    id: guild.id,
    name: safeDisplay(guild.name) || '(unnamed guild)',
    administrator: (permissions & ADMINISTRATOR_PERMISSION) === ADMINISTRATOR_PERMISSION,
  };
}

export async function discoverDiscordSetup(token: string): Promise<DiscordSetupDiscovery> {
  const rawUser = await discordGet('/users/@me', token);
  if (rawUser === null || typeof rawUser !== 'object') {
    throw new Error('Discord returned an invalid bot identity');
  }
  const user = rawUser as { id?: unknown; username?: unknown; bot?: unknown };
  if (
    typeof user.id !== 'string' ||
    !SNOWFLAKE.test(user.id) ||
    typeof user.username !== 'string' ||
    user.bot !== true
  ) {
    throw new Error('DISCORD_TOKEN must identify a Discord bot account');
  }

  const guilds: DiscordSetupGuild[] = [];
  const seen = new Set<string>();
  let after: string | undefined;

  for (;;) {
    const query = new URLSearchParams({ limit: '200', with_counts: 'false' });
    if (after !== undefined) query.set('after', after);
    const rawPage = await discordGet(`/users/@me/guilds?${query.toString()}`, token);
    if (!Array.isArray(rawPage)) {
      throw new Error('Discord returned an invalid guild list');
    }

    const page = rawPage.map(parseGuild);
    for (const guild of page) {
      if (seen.has(guild.id)) {
        throw new Error('Discord returned a duplicate guild page');
      }
      seen.add(guild.id);
      guilds.push(guild);
    }

    if (page.length < 200) break;
    after = page.at(-1)?.id;
    if (after === undefined) throw new Error('Discord guild pagination did not advance');
  }

  return {
    bot: { id: user.id, username: safeDisplay(user.username) || '(unnamed bot)' },
    guilds,
  };
}

/**
 * Resolve the absolute path to the running CLI script. Used as the
 * second `serverArgs` element when emitting `node <cli.js>`.
 *
 * Uses `import.meta.url` (Node 20+ ESM-stable) via `fileURLToPath`.
 * `import.meta.dirname` would be slightly cleaner but tsdown's bundle
 * output may reshape directory layout; resolving via URL is portable
 * across both source-mode (vitest) and bundled-mode (production).
 *
 * `fileURLToPath` - NOT `URL.pathname`. A pathname is percent-encoded
 * (a path with a space or a non-ASCII segment comes out as `%20` /
 * `%C3%B6`) and on Windows it carries a leading slash with forward
 * slashes (`/C:/Users/...`). Both forms are unspawnable by the MCP
 * client we are generating the config for.
 *
 * The bundled init command is a sibling chunk of `dist/cli.js`, whereas
 * source-mode init lives under `src/commands/`. Prefer a real sibling
 * `cli.js` first, then retain the source-mode fallback. This keeps emitted
 * configs executable after packaging instead of pointing at the package root.
 *
 * `moduleUrl` is a parameter only so tests can exercise this against
 * paths the repo checkout doesn't have; production always uses the default.
 */
export function resolveCliPath(moduleUrl: string = import.meta.url): string {
  const modulePath = fileURLToPath(moduleUrl);
  const bundledCliPath = resolve(dirname(modulePath), 'cli.js');
  if (existsSync(bundledCliPath)) {
    return bundledCliPath;
  }

  // commands/init.js → ../cli.js in source mode.
  return fileURLToPath(new URL('../cli.js', moduleUrl));
}

export async function initAction(opts: InitOptions): Promise<void> {
  const asJson = opts.json === true;

  // 1. Resolve client.
  let clientId = opts.client;
  if (clientId === undefined) {
    if (isInteractive()) {
      clientId = await askChoice(
        'Which MCP client?',
        ALL_GENERATORS.map((g) => g.id),
        0,
      );
    } else {
      clientId = 'generic';
    }
  }
  const generator = ALL_GENERATORS.find((g) => g.id === clientId);
  if (!generator) {
    emitResult(
      {
        ok: false,
        exitCode: 2,
        summary: `unknown client: ${clientId}`,
        errors: [`Available clients: ${ALL_GENERATORS.map((g) => g.id).join(', ')}`],
      },
      asJson,
    );
    return;
  }

  // 2. Resolve token. Omission always means environment forwarding. A real
  //    token only enters generated output through the explicit --token flag.
  let token = opts.token ?? TOKEN_PLACEHOLDER;
  if (token === '' || token === TOKEN_PLACEHOLDER) {
    token = TOKEN_PLACEHOLDER;
  }

  // 3. Resolve gateway flag.
  let gateway = opts.gateway;
  if (gateway === undefined) {
    if (isInteractive()) {
      gateway = await askYesNo('Enable Discord Gateway resource subscriptions?', false);
    } else {
      gateway = false;
    }
  }

  // 4. Resolve advertised tool surface.
  const toolSurface = opts.toolSurface ?? 'full';
  if (toolSurface !== 'full' && toolSurface !== 'progressive') {
    emitResult(
      {
        ok: false,
        exitCode: 2,
        summary: `unknown tool surface: ${toolSurface}`,
        errors: ['Available tool surfaces: full, progressive'],
      },
      asJson,
    );
    return;
  }

  let allowedGuilds = opts.allowedGuilds?.split(',').map((guildId) => guildId.trim());
  if (
    allowedGuilds !== undefined &&
    (allowedGuilds.length === 0 || allowedGuilds.some((guildId) => !SNOWFLAKE.test(guildId)))
  ) {
    emitResult(
      {
        ok: false,
        exitCode: 2,
        summary: 'invalid allowed guild list',
        errors: ['--allowed-guilds must be a comma-separated list of Discord snowflake IDs'],
      },
      asJson,
    );
    return;
  }

  let discord: DiscordSetupDiscovery | undefined;
  const warnings: string[] = [];
  if (opts.discoverGuilds === true) {
    const discoveryToken = token === TOKEN_PLACEHOLDER ? process.env.DISCORD_TOKEN : token;
    if (discoveryToken === undefined || discoveryToken === '') {
      emitResult(
        {
          ok: false,
          exitCode: 2,
          summary: 'cannot discover Discord guilds without a token',
          errors: [
            'Set DISCORD_TOKEN in this terminal, then rerun init --discover-guilds. The default config forwards the environment variable without persisting it.',
          ],
        },
        asJson,
      );
      return;
    }

    try {
      discord = await discoverDiscordSetup(discoveryToken);
    } catch (error) {
      emitResult(
        {
          ok: false,
          exitCode: 2,
          summary: 'Discord guild discovery failed',
          errors: [error instanceof Error ? error.message : String(error)],
        },
        asJson,
      );
      return;
    }

    if (discord.guilds.length === 0) {
      emitResult(
        {
          ok: false,
          exitCode: 2,
          summary: `verified ${discord.bot.username}, but the bot is not installed in any guild`,
          errors: [
            'Invite the bot to the intended Discord server and rerun init --discover-guilds.',
          ],
          data: { discord },
        },
        asJson,
      );
      return;
    }

    if (allowedGuilds !== undefined) {
      const visibleIds = new Set(discord.guilds.map((guild) => guild.id));
      const missing = allowedGuilds.filter((guildId) => !visibleIds.has(guildId));
      if (missing.length > 0) {
        emitResult(
          {
            ok: false,
            exitCode: 2,
            summary: 'the requested guild allowlist is not visible to this bot',
            errors: missing.map((guildId) => `${guildId} is not visible to the verified bot`),
            data: { discord },
          },
          asJson,
        );
        return;
      }
    } else if (discord.guilds.length === 1) {
      allowedGuilds = [discord.guilds[0]!.id];
    } else if (isInteractive()) {
      const cancelChoice = 'Cancel setup without selecting a guild';
      const choices = [
        cancelChoice,
        ...discord.guilds.map(
          (guild) => `${guild.name} (${guild.id})${guild.administrator ? ' [Administrator]' : ''}`,
        ),
      ];
      const choice = await askChoice('Which Discord guild should this config allow?', choices, 0);
      if (choice === cancelChoice) {
        emitResult(
          {
            ok: false,
            exitCode: 2,
            summary: 'guild selection cancelled',
            errors: ['Rerun init --discover-guilds and explicitly choose the intended guild.'],
            data: { discord },
          },
          asJson,
        );
        return;
      }
      const choiceIndex = choices.indexOf(choice) - 1;
      allowedGuilds = [discord.guilds[choiceIndex]!.id];
    } else {
      emitResult(
        {
          ok: false,
          exitCode: 2,
          summary: 'the verified bot can see multiple guilds',
          details: discord.guilds.map(
            (guild) => `${guild.id}  ${guild.name}${guild.administrator ? ' [Administrator]' : ''}`,
          ),
          errors: [
            'Pass --allowed-guilds <id,id,...> with the intended target, then keep --discover-guilds to verify it.',
          ],
          data: { discord },
        },
        asJson,
      );
      return;
    }

    const selectedIds = new Set(allowedGuilds);
    for (const guild of discord.guilds) {
      if (selectedIds.has(guild.id) && guild.administrator) {
        warnings.push(
          `Bot has Administrator in ${guild.name} (${guild.id}); remove it and grant only the Discord permissions required by your workflows.`,
        );
      }
    }
  }

  // 6. Resolve server path. We default to `node <abs cli.js>` because
  //    this works for every install (workspace, global, npx-cached) at
  //    the cost of being installation-specific.
  const serverPath = process.execPath;
  const serverArgs: string[] = [resolveCliPath()];

  // 7. Generate snippet.
  const envVars: Record<string, string> = {};
  if (toolSurface === 'progressive') envVars.MCP_TOOL_SURFACE = 'progressive';
  if (allowedGuilds !== undefined) envVars.ALLOWED_GUILDS = allowedGuilds.join(',');
  if (discord !== undefined) envVars.DISCORD_EXPECTED_BOT_ID = discord.bot.id;

  const snippet = generator.generate({
    serverPath,
    serverArgs,
    discordToken: token,
    gateway,
    ...(Object.keys(envVars).length > 0 ? { envVars } : {}),
  });

  // 8. Write or print.
  let writtenTo: string | undefined;
  if (opts.output !== undefined) {
    if (existsSync(opts.output) && opts.force !== true) {
      emitResult(
        {
          ok: false,
          exitCode: 2,
          summary: `${opts.output} exists; use --force to overwrite`,
        },
        asJson,
      );
      return;
    }
    writeFileSync(opts.output, snippet.content, 'utf8');
    writtenTo = opts.output;
  }

  const portabilityNote =
    generator.id === 'codex'
      ? 'For a portable Codex configuration, set command = "npx" and args = ["-y", "@discord-mcp/cli"] in the TOML fragment.'
      : 'Adjust the `command` field if you install discord-mcp globally (e.g. set command="npx" args=["@discord-mcp/cli"]).';

  const exitCode = warnings.length > 0 ? 1 : 0;
  const discordDetails =
    discord === undefined
      ? []
      : [
          `Verified Discord bot: ${discord.bot.username} (${discord.bot.id})`,
          `Allowed Discord guilds: ${allowedGuilds?.join(', ') ?? 'none'}`,
          '',
        ];

  emitResult(
    {
      ok: exitCode === 0,
      exitCode,
      summary:
        writtenTo !== undefined
          ? `wrote ${generator.displayName} config to ${writtenTo}`
          : `generated ${generator.displayName} config (use --output <path> to write to a file)`,
      data: {
        client: generator.id,
        configFilePath: snippet.configFilePath,
        content: snippet.content,
        instructions: snippet.instructions,
        gateway,
        toolSurface,
        allowedGuilds: allowedGuilds ?? [],
        ...(discord === undefined ? {} : { discord }),
      },
      ...(warnings.length > 0 ? { warnings } : {}),
      details:
        writtenTo !== undefined
          ? [
              ...discordDetails,
              snippet.instructions,
              '',
              `Suggested config path:`,
              snippet.configFilePath,
              '',
              portabilityNote,
            ]
          : [
              ...discordDetails,
              snippet.instructions,
              '',
              `Suggested config path:`,
              snippet.configFilePath,
              '',
              portabilityNote,
              '',
              'Snippet:',
              snippet.content.trimEnd(),
            ],
    },
    asJson,
  );
}
