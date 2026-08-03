#!/usr/bin/env node
/**
 * discord-mcp CLI entry point.
 *
 * Plan 9 Phase A: commander sub-command router.
 * - `serve` is the default sub-command (`isDefault: true`) so a bare
 *   `discord-mcp` invocation still boots the stdio MCP server. `serve --http`
 *   exposes a bearer-protected Streamable HTTP endpoint for remote clients.
 * - `--gateway` lives on `serve`. Bare `discord-mcp --gateway` is
 *   forwarded to `serve` through commander's default-subcommand passthrough.
 * - Lifecycle and diagnostic sub-commands emit a structured CommandResult
 *   via emitResult().
 * - Non-serve handlers are lazy-imported (`await import(...)`) so cold-start
 *   for `serve` (the hot path) is unaffected by their deps.
 *
 * `program` is exported so tests can drive `parseAsync` without spawning
 * a child process. Auto-parse is suppressed under VITEST so tests can
 * call `parseAsync(['node', 'cli.js', ...args])` with synthetic argv.
 *
 * `buildProgram()` returns a FRESH command tree. Commander never clears
 * its parsed option values between `parseAsync` calls, so a suite that
 * reuses one instance leaks flags (e.g. `--json`) into later tests;
 * tests build a new program per case instead.
 */
import { Command } from 'commander';
import packageJson from '../package.json' with { type: 'json' };
import { serveAction } from './commands/serve.js';
import type { ActivityContext } from './lib/activity.js';

async function captureCliActivity<T>(
  context: ActivityContext,
  action: () => Promise<T>,
): Promise<T> {
  // Unit tests intentionally execute command handlers in-process. Keep their
  // synthetic runs out of a developer's real local evidence journal.
  if (process.env.VITEST === 'true') return action();
  const { captureActivity } = await import('./lib/activity.js');
  return captureActivity(context, action);
}

export function buildProgram(): Command {
  const program = new Command('discord-mcp')
    .description('Discord MCP server - stdio and Streamable HTTP transport for AI agents')
    .version(packageJson.version);

  program
    .command('serve', { isDefault: true })
    .description('Start the MCP server over stdio (default) or Streamable HTTP')
    .option('--gateway', 'Enable Discord Gateway resource subscriptions (lazy-imports discord.js)')
    .option('--http', 'Serve Streamable HTTP MCP at /mcp (requires DISCORD_MCP_ACCESS_TOKEN)')
    .option('--host <host>', 'HTTP listen host (default: 127.0.0.1)')
    .option('--port <port>', 'HTTP listen port (default: 3000)', Number)
    .option('--profile <name>', 'Load a caller-owned bot profile before startup')
    .action(
      async (options: {
        gateway?: boolean;
        http?: boolean;
        host?: string;
        port?: number;
        profile?: string;
      }) => {
        await serveAction(options);
      },
    );

  program
    .command('doctor')
    .description('Diagnose configuration, token, and connectivity issues')
    .option('--json', 'Emit machine-readable JSON instead of pretty output')
    .option('--online', 'Run online checks against Discord (requires DISCORD_TOKEN)')
    .option('--profile <name>', 'Load a caller-owned bot profile before checks')
    .action(async (options: { json?: boolean; online?: boolean; profile?: string }) => {
      const { doctorAction } = await import('./commands/doctor.js');
      await captureCliActivity({ command: 'doctor', online: options.online === true }, async () =>
        doctorAction(options),
      );
    });

  program
    .command('smoke')
    .description('Verify the real MCP-to-Discord path (read-only by default)')
    .option('--confirm-write', 'Run one self-cleaning create/send/edit/delete lifecycle')
    .option('--guild-id <id>', 'Target guild for write smoke; required when the bot sees multiple')
    .option('--json', 'Emit machine-readable JSON instead of pretty output')
    .option('--profile <name>', 'Load a caller-owned bot profile before verification')
    .action(
      async (options: {
        confirmWrite?: boolean;
        guildId?: string;
        json?: boolean;
        profile?: string;
      }) => {
        const { smokeAction } = await import('./commands/smoke.js');
        await captureCliActivity(
          { command: 'smoke', confirmWrite: options.confirmWrite === true },
          async () => smokeAction(options),
        );
      },
    );

  program
    .command('setup')
    .description('Guided setup for one caller-owned Discord bot profile')
    .option('--profile <name>', 'Stable local profile name (required when not interactive)')
    .option(
      '--client <id>',
      'MCP client (claude-desktop|claude-code|codex|cursor|generic). Default: prompt if TTY, else "generic".',
    )
    .option('--gateway', 'Enable Discord Gateway resource subscriptions for this profile')
    .option(
      '--tool-surface <mode>',
      'Advertised tool surface (full|progressive). Default: progressive',
      'progressive',
    )
    .option('--allowed-guilds <ids>', 'Comma-separated guild IDs to verify and allow')
    .option('--output <path>', 'Write the generated client snippet to this path')
    .option('--force', 'Update the same bot profile and overwrite --output if needed')
    .option('--json', 'Emit machine-readable JSON instead of pretty output')
    .action(
      async (options: {
        profile?: string;
        client?: string;
        gateway?: boolean;
        toolSurface?: string;
        allowedGuilds?: string;
        output?: string;
        force?: boolean;
        json?: boolean;
      }) => {
        const { setupAction } = await import('./commands/setup.js');
        await captureCliActivity({ command: 'setup' }, async () => setupAction(options));
      },
    );

  program
    .command('activity')
    .description('Show local, privacy-safe setup and verification outcomes')
    .option('--json', 'Emit machine-readable JSON instead of pretty output')
    .action(async (options: { json?: boolean }) => {
      const { activityAction } = await import('./commands/activity.js');
      activityAction(options);
    });

  const profile = program
    .command('profile')
    .description('List, inspect, or remove non-secret caller-owned bot profiles');
  profile
    .command('list')
    .description('List configured profiles')
    .option('--json', 'Emit machine-readable JSON instead of pretty output')
    .action(async (options: { json?: boolean }) => {
      const { profileListAction } = await import('./commands/profile.js');
      profileListAction(options);
    });
  profile
    .command('show <name>')
    .description('Show one profile without resolving or printing its token')
    .option('--json', 'Emit machine-readable JSON instead of pretty output')
    .action(async (name: string, options: { json?: boolean }) => {
      const { profileShowAction } = await import('./commands/profile.js');
      profileShowAction(name, options);
    });
  profile
    .command('remove <name>')
    .description('Remove one local profile without revoking its Discord token')
    .option('--yes', 'Confirm removal without an interactive prompt')
    .option('--json', 'Emit machine-readable JSON instead of pretty output')
    .action(async (name: string, options: { yes?: boolean; json?: boolean }) => {
      const { profileRemoveAction } = await import('./commands/profile.js');
      await profileRemoveAction(name, options);
    });

  program
    .command('init')
    .description(
      'Generate an MCP client config snippet (Claude Desktop / Claude Code / Codex / Cursor / Generic)',
    )
    .option(
      '--client <id>',
      'MCP client (claude-desktop|claude-code|codex|cursor|generic). Default: prompt if TTY, else "generic".',
    )
    .option(
      '--token <token>',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal placeholder shown in --help
      'Discord bot token. WARNING: writes the value into the config file unredacted. Omit to use the ${env:DISCORD_TOKEN} placeholder.',
    )
    .option(
      '--gateway',
      'Append --gateway to the snippet so the server enables Discord Gateway resource subscriptions',
    )
    .option(
      '--tool-surface <mode>',
      'Advertised tool surface (full|progressive). Default: full',
      'full',
    )
    .option(
      '--allowed-guilds <ids>',
      'Comma-separated guild IDs enforced by the server (recommended for bot safety)',
    )
    .option(
      '--discover-guilds',
      'Verify DISCORD_TOKEN online and safely select or validate the guild allowlist',
    )
    .option('--output <path>', 'Write the snippet to this path instead of stdout')
    .option('--force', 'Overwrite the --output path if it already exists')
    .option('--json', 'Emit machine-readable JSON instead of pretty output')
    .action(
      async (options: {
        client?: string;
        token?: string;
        gateway?: boolean;
        toolSurface?: string;
        allowedGuilds?: string;
        discoverGuilds?: boolean;
        output?: string;
        force?: boolean;
        json?: boolean;
      }) => {
        const { initAction } = await import('./commands/init.js');
        await initAction(options);
      },
    );

  program
    .command('migrate')
    .description('Migrate from another Discord setup (e.g. hubdustry-go-mcp)')
    .option('--from <adapter>', 'Source adapter id (run --list to see available)')
    .option('--source <path>', 'Path to source repo (default: cwd)')
    .option('--list', 'List all available adapters')
    .option('--json', 'Output as JSON instead of TTY-friendly text')
    .action(async (options: { from?: string; source?: string; list?: boolean; json?: boolean }) => {
      const { migrateAction } = await import('./commands/migrate.js');
      await migrateAction(options);
    });

  return program;
}

export const program = buildProgram();

// Run the parser only when invoked as the bin script (not when imported
// from tests). Vitest sets VITEST=true for every worker; we use it to
// suppress auto-parse during unit tests, which import `program` and
// drive parseAsync directly with synthetic argv.
if (process.env.VITEST !== 'true') {
  await program.parseAsync(process.argv);
}
