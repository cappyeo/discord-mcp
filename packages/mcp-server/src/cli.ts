#!/usr/bin/env node
/**
 * discord-mcp CLI entry point.
 *
 * Plan 9 Phase A: commander sub-command router.
 * - `serve` is the default sub-command (`isDefault: true`) so a bare
 *   `discord-mcp` invocation still boots the stdio MCP server.
 * - `--gateway` lives on `serve`. Bare `discord-mcp --gateway` is
 *   forwarded to `serve` through commander's default-subcommand passthrough.
 * - `doctor`, `init`, `migrate` are real sub-commands as of Plan 9
 *   Phases B (doctor), D (init), and E (migrate). Each emits a
 *   structured CommandResult via emitResult().
 * - Doctor / init / migrate handlers are lazy-imported (`await import(...)`)
 *   so cold-start for `serve` (the hot path) is unaffected by their deps.
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

export function buildProgram(): Command {
  const program = new Command('discord-mcp')
    .description('Discord MCP server — stdio transport for AI agents')
    .version(packageJson.version);

  program
    .command('serve', { isDefault: true })
    .description('Start the stdio MCP server (default)')
    .option('--gateway', 'Enable Discord Gateway resource subscriptions (lazy-imports discord.js)')
    .action(async (options: { gateway?: boolean }) => {
      await serveAction(options);
    });

  program
    .command('doctor')
    .description('Diagnose configuration, token, and connectivity issues')
    .option('--json', 'Emit machine-readable JSON instead of pretty output')
    .option('--online', 'Run online checks against Discord (requires DISCORD_TOKEN)')
    .action(async (options: { json?: boolean; online?: boolean }) => {
      const { doctorAction } = await import('./commands/doctor.js');
      await doctorAction(options);
    });

  program
    .command('init')
    .description(
      'Generate an MCP client config snippet (Claude Desktop / Claude Code / Cursor / Generic)',
    )
    .option(
      '--client <id>',
      'MCP client (claude-desktop|claude-code|cursor|generic). Default: prompt if TTY, else "generic".',
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
    .option('--output <path>', 'Write the snippet to this path instead of stdout')
    .option('--force', 'Overwrite the --output path if it already exists')
    .option('--json', 'Emit machine-readable JSON instead of pretty output')
    .action(
      async (options: {
        client?: string;
        token?: string;
        gateway?: boolean;
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
