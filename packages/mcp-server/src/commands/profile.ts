import { emitResult } from '../lib/output.js';
import {
  listProfiles,
  loadProfile,
  normalizeProfileName,
  type ProfileLocationOptions,
  profileExists,
  removeProfile,
} from '../lib/profiles.js';
import { askYesNo, isInteractive } from '../lib/prompt.js';

interface ProfileCommandOptions {
  json?: boolean;
  profileDirectory?: string;
}

export interface ProfileRemoveOptions extends ProfileCommandOptions {
  yes?: boolean;
}

function location(options: ProfileCommandOptions): ProfileLocationOptions {
  return options.profileDirectory === undefined ? {} : { directory: options.profileDirectory };
}

export function profileListAction(options: ProfileCommandOptions): void {
  try {
    const profiles = listProfiles(location(options));
    emitResult(
      {
        ok: true,
        exitCode: 0,
        summary:
          profiles.length === 0
            ? 'no caller-owned bot profiles configured'
            : `found ${profiles.length} caller-owned bot profile${profiles.length === 1 ? '' : 's'}`,
        details: profiles.map(
          (profile) =>
            `${profile.name}: ${profile.bot.username} (${profile.bot.id}), ${profile.allowedGuilds.length} allowed guild${profile.allowedGuilds.length === 1 ? '' : 's'}, ${profile.client}/${profile.toolSurface}, categories=${profile.categories?.join(',') ?? 'all'}, write=${profile.writeMode ?? 'allow'}`,
        ),
        data: { profiles },
      },
      options.json === true,
    );
  } catch (error) {
    emitResult(
      {
        ok: false,
        exitCode: 2,
        summary: 'could not list profiles',
        errors: [error instanceof Error ? error.message : String(error)],
      },
      options.json === true,
    );
  }
}

export function profileShowAction(name: string, options: ProfileCommandOptions): void {
  try {
    const profile = loadProfile(name, location(options));
    emitResult(
      {
        ok: true,
        exitCode: 0,
        summary: `profile ${profile.name} is locked to ${profile.bot.username} (${profile.bot.id})`,
        details: [
          `Credential provider: ${profile.credential.provider}:${profile.credential.variable}`,
          `Allowed guilds: ${profile.allowedGuilds.join(', ')}`,
          `Client/tool surface: ${profile.client}/${profile.toolSurface}`,
          `Categories: ${profile.categories?.join(', ') ?? 'all (server validates names at boot)'}`,
          `Write mode: ${profile.writeMode ?? 'allow'}${profile.writeMode === undefined ? ' (legacy profile default)' : ''}`,
          `Gateway: ${profile.gateway ? 'enabled' : 'disabled'}`,
        ],
        data: { profile },
      },
      options.json === true,
    );
  } catch (error) {
    emitResult(
      {
        ok: false,
        exitCode: 2,
        summary: `could not load profile ${name}`,
        errors: [error instanceof Error ? error.message : String(error)],
      },
      options.json === true,
    );
  }
}

export async function profileRemoveAction(
  name: string,
  options: ProfileRemoveOptions,
): Promise<void> {
  const asJson = options.json === true;
  try {
    const normalizedName = normalizeProfileName(name);
    if (!profileExists(normalizedName, location(options))) {
      throw new Error(`Profile not found: ${normalizedName}`);
    }
    let confirmed = options.yes === true;
    if (!confirmed && isInteractive()) {
      confirmed = await askYesNo(
        `Remove profile ${normalizedName}? This does not revoke its Discord bot token.`,
        false,
      );
    }
    if (!confirmed) {
      emitResult(
        {
          ok: false,
          exitCode: 2,
          summary: `profile ${normalizedName} was not removed`,
          errors: [
            isInteractive() ? 'Removal was cancelled.' : 'Non-interactive removal requires --yes.',
          ],
        },
        asJson,
      );
      return;
    }

    const path = removeProfile(normalizedName, location(options));
    emitResult(
      {
        ok: true,
        exitCode: 0,
        summary: `removed profile ${normalizedName}`,
        details: [
          path,
          'The caller-owned Discord token was not revoked or changed. Reset it in the Discord Developer Portal if the bot is being retired or the token may be exposed.',
        ],
        data: { name: normalizedName, path, tokenRevoked: false },
      },
      asJson,
    );
  } catch (error) {
    emitResult(
      {
        ok: false,
        exitCode: 2,
        summary: `could not remove profile ${name}`,
        errors: [error instanceof Error ? error.message : String(error)],
      },
      asJson,
    );
  }
}
