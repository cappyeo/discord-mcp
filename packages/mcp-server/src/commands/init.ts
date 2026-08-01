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
 *   2. Resolve the Discord token (`--token` OR interactive prompt OR
 *      `${env:DISCORD_TOKEN}` placeholder so users don't accidentally
 *      bake a real secret into a committed file).
 *   3. Resolve the gateway flag (`--gateway` OR interactive yes/no OR
 *      false by default).
 *   4. Pick a serverPath/serverArgs strategy. We use the current Node
 *      binary + the resolved CLI script - works for any installation
 *      (workspace, global npm, npx) at the cost of an absolute path
 *      that may need editing if the user later moves the project.
 *      The output explicitly tells the user how to switch to
 *      `npx @discord-mcp/cli` for portable distribution.
 *   5. Generate the snippet via the chosen ClientGenerator.
 *   6. Either write to `--output <path>` (with `--force` for overwrite
 *      protection) or print to stdout / structured payload.
 *
 * Token redaction: in pretty mode the snippet text contains whatever
 * `--token` was passed - including raw secrets. The CLI flag's help
 * text warns about this. The placeholder default avoids the issue
 * entirely. We do NOT echo the token in any other log line.
 */
import { existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ALL_GENERATORS } from '../lib/client-snippets/index.js';
import { emitResult } from '../lib/output.js';
import { ask, askChoice, askYesNo, isInteractive } from '../lib/prompt.js';

export interface InitOptions {
  token?: string;
  client?: string;
  output?: string;
  force?: boolean;
  gateway?: boolean;
  json?: boolean;
}

// Literal placeholder string used when the user opts out of supplying a
// real token. Clients that support env-var interpolation (Claude Desktop,
// Cursor, etc.) will resolve this at startup; clients that don't will
// flag it as a missing token so the user notices.
//
// biome-ignore lint/suspicious/noTemplateCurlyInString: literal placeholder for MCP client env interpolation
const TOKEN_PLACEHOLDER = '${env:DISCORD_TOKEN}';

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
 * `moduleUrl` is a parameter only so tests can exercise this against
 * paths the repo checkout doesn't have; production always uses the
 * default.
 */
export function resolveCliPath(moduleUrl: string = import.meta.url): string {
  // moduleUrl points to the running .js file (or .ts under vitest).
  // For source mode we want the cli.js sibling to commands/; the user
  // will manually adjust if they install via npx.
  // commands/init.js → ../cli.js
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

  // 2. Resolve token. The empty/placeholder branches collapse to the
  //    explicit env-var-interpolation placeholder.
  let token = opts.token;
  if (token === undefined) {
    if (isInteractive()) {
      token = await ask(
        // biome-ignore lint/suspicious/noTemplateCurlyInString: literal placeholder shown to the user
        'Discord bot token (leave empty for ${env:DISCORD_TOKEN} placeholder)',
        TOKEN_PLACEHOLDER,
      );
    } else {
      token = TOKEN_PLACEHOLDER;
    }
  }
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

  // 4. Resolve server path. We default to `node <abs cli.js>` because
  //    this works for every install (workspace, global, npx-cached) at
  //    the cost of being installation-specific.
  const serverPath = process.execPath;
  const serverArgs: string[] = [resolveCliPath()];

  // 5. Generate snippet.
  const snippet = generator.generate({
    serverPath,
    serverArgs,
    discordToken: token,
    gateway,
  });

  // 6. Write or print.
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
    'Adjust the `command` field if you install discord-mcp globally (e.g. set command="npx" args=["@discord-mcp/cli"]).';

  emitResult(
    {
      ok: true,
      exitCode: 0,
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
      },
      details:
        writtenTo !== undefined
          ? [
              snippet.instructions,
              '',
              `Suggested config path:`,
              snippet.configFilePath,
              '',
              portabilityNote,
            ]
          : [
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
