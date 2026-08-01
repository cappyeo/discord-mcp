import { container } from '@sapphire/pieces';
import { Routes } from 'discord-api-types/v10';
import { z } from 'zod';
import { defineTool } from '../_lib/defineTool.js';
import { dualResult } from '../_lib/response.js';
import { GuildId, SoundboardSoundId } from '../_lib/snowflake.js';

export default defineTool({
  name: 'soundboard_delete_guild_sound',
  category: 'soundboard',
  preconditions: ['confirm_required'] as const,
  description: [
    '**Purpose**: Delete a guild soundboard sound. **DESTRUCTIVE - IRREVERSIBLE.**',
    '',
    '**Returns**: `{deleted, sound_id, guild_id}`.',
    '',
    '**Security**: gated by `ConfirmRequired`. Pass `__confirm:true` AND set `MCP_DRY_RUN=false`.',
  ].join('\n'),
  inputSchema: {
    guild_id: GuildId.describe('Guild containing the sound'),
    sound_id: SoundboardSoundId.describe('Sound to delete (IRREVERSIBLE)'),
    audit_reason: z
      .string()
      .min(1)
      .max(512)
      .optional()
      .describe('Reason recorded in audit log (X-Audit-Log-Reason header)'),
  },
  outputSchema: {
    deleted: z.literal(true),
    sound_id: SoundboardSoundId,
    guild_id: GuildId,
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  handler: async (args) => {
    await container.rest.delete(Routes.guildSoundboardSound(args.guild_id, args.sound_id), {
      reason: args.audit_reason,
    });
    return dualResult({
      text: `Deleted soundboard sound \`${args.sound_id}\` from guild \`${args.guild_id}\`.`,
      data: {
        deleted: true as const,
        sound_id: args.sound_id,
        guild_id: args.guild_id,
      },
    });
  },
});
