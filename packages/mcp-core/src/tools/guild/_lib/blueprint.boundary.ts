import type { Config } from '../../../config.js';
import { parseGuildAllowlist } from '../../../middleware/guild-allowlist.js';
import type { BlueprintBlocker } from './blueprint.execution.schema.js';

export function blueprintBoundaryBlockers(
  config: Config,
  guildId: string,
  expectedBotId: string,
): BlueprintBlocker[] {
  const blockers: BlueprintBlocker[] = [];
  if (config.DISCORD_EXPECTED_BOT_ID === undefined) {
    blockers.push({
      code: 'CONFIG_EXPECTED_BOT_REQUIRED',
      message: 'Target-bound blueprint execution requires DISCORD_EXPECTED_BOT_ID.',
      resource: null,
      recovery_hint: 'Set the caller-owned bot ID in the selected profile, then restart once.',
    });
  } else if (config.DISCORD_EXPECTED_BOT_ID !== expectedBotId) {
    blockers.push({
      code: 'EXPECTED_BOT_MISMATCH',
      message: 'The requested expected_bot_id differs from the locked caller profile.',
      resource: `bot:${expectedBotId}`,
      recovery_hint: 'Use the bot ID locked by the selected profile; never substitute another bot.',
    });
  }
  const allowlist = parseGuildAllowlist(config.ALLOWED_GUILDS);
  if (allowlist === null) {
    blockers.push({
      code: 'CONFIG_GUILD_ALLOWLIST_REQUIRED',
      message: 'Target-bound blueprint execution requires ALLOWED_GUILDS.',
      resource: null,
      recovery_hint:
        'Allowlist the exact target guild in the selected caller profile, then restart once.',
    });
  } else if (!allowlist.has(guildId)) {
    blockers.push({
      code: 'TARGET_GUILD_NOT_ALLOWED',
      message: 'The explicitly selected guild is not present in ALLOWED_GUILDS.',
      resource: `guild:${guildId}`,
      recovery_hint: 'Choose an allowlisted guild or deliberately update the caller profile.',
    });
  }
  return blockers;
}
