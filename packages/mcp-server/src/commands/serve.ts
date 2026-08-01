/**
 * `discord-mcp serve` - start the stdio MCP server.
 *
 * Plan 9 Phase A. This is the sub-command form of the original
 * top-level action in cli.ts; it remains the default sub-command
 * (commander `{ isDefault: true }` in cli.ts) so `discord-mcp`
 * with no args still boots stdio.
 *
 * `process.exit(1)` discipline: stdio cannot drain naturally on a
 * boot failure (the transport never connected, so there is nothing
 * to flush; the process is otherwise idle waiting on the event loop
 * via signal handlers registered inside startStdio). serve is the
 * ONE command that calls process.exit - every other command uses
 * process.exitCode + return so Node drains stdout/stderr first.
 */
import { startStdio } from '../transports/stdio.js';

export interface ServeOptions {
  gateway?: boolean;
}

export async function serveAction(options: ServeOptions): Promise<void> {
  if (options.gateway === true) {
    process.env.GATEWAY = '1';
  }
  try {
    await startStdio();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`discord-mcp failed to start: ${msg}\n`);
    // See file-level JSDoc for why this is the one allowed process.exit.
    process.exit(1);
  }
}
