/**
 * `discord-mcp serve` - start the local stdio MCP server or remote HTTP endpoint.
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
import { activateProfile } from '../lib/profiles.js';

export interface ServeOptions {
  gateway?: boolean;
  http?: boolean;
  host?: string;
  port?: number;
  profile?: string;
  profileDirectory?: string;
}

export async function serveAction(options: ServeOptions): Promise<void> {
  try {
    const profile =
      options.profile === undefined
        ? undefined
        : activateProfile(options.profile, {
            ...(options.profileDirectory === undefined
              ? {}
              : { directory: options.profileDirectory }),
          });
    if (options.http === true && (options.gateway === true || profile?.gateway === true)) {
      throw new Error('Gateway subscriptions are available only with the stdio transport.');
    }
    if (options.http === true) {
      const { startHttp } = await import('../transports/http.js');
      await startHttp({
        ...(options.host === undefined ? {} : { host: options.host }),
        ...(options.port === undefined ? {} : { port: options.port }),
      });
    } else {
      if (options.gateway === true || profile?.gateway === true) {
        process.env.GATEWAY = '1';
      }
      const { startStdio } = await import('../transports/stdio.js');
      await startStdio();
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`discord-mcp failed to start: ${msg}\n`);
    // See file-level JSDoc for why this is the one allowed process.exit.
    process.exit(1);
  }
}
