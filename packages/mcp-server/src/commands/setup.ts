import { emitResult } from '../lib/output.js';
import { ask, isInteractive } from '../lib/prompt.js';
import { initAction } from './init.js';

export interface SetupOptions {
  profile?: string;
  client?: string;
  output?: string;
  force?: boolean;
  gateway?: boolean;
  toolSurface?: string;
  allowedGuilds?: string;
  json?: boolean;
  profileDirectory?: string;
}

export async function setupAction(options: SetupOptions): Promise<void> {
  let profileName = options.profile;
  if (profileName === undefined) {
    if (!isInteractive()) {
      emitResult(
        {
          ok: false,
          exitCode: 2,
          summary: 'non-interactive setup requires --profile <name>',
          errors: [
            'Choose a stable lowercase profile name, for example: discord-mcp setup --profile devbot --client codex',
          ],
        },
        options.json === true,
      );
      return;
    }
    profileName = await ask('Profile name', 'default');
  }

  await initAction({
    ...(options.client === undefined ? {} : { client: options.client }),
    ...(options.output === undefined ? {} : { output: options.output }),
    ...(options.force === undefined ? {} : { force: options.force }),
    ...(options.gateway === undefined ? {} : { gateway: options.gateway }),
    toolSurface: options.toolSurface ?? 'progressive',
    ...(options.allowedGuilds === undefined ? {} : { allowedGuilds: options.allowedGuilds }),
    ...(options.json === undefined ? {} : { json: options.json }),
    discoverGuilds: true,
    profile: {
      name: profileName,
      ...(options.profileDirectory === undefined ? {} : { directory: options.profileDirectory }),
    },
  });
}
