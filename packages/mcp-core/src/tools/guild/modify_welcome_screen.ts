import { container } from '@sapphire/pieces';
import { Routes } from 'discord-api-types/v10';
import { z } from 'zod';
import { withAttributionField } from '../_lib/attribution.js';
import { defineTool } from '../_lib/defineTool.js';
import { dualResult } from '../_lib/response.js';
import { ChannelId, GuildId } from '../_lib/snowflake.js';

interface RawWelcomeScreen {
  description: string | null;
  welcome_channels: Array<{
    channel_id: string;
    description: string;
    emoji_id: string | null;
    emoji_name: string | null;
  }>;
}

export default defineTool({
  name: 'guild_modify_welcome_screen',
  category: 'guild',
  description: [
    '**Purpose**: Update the Community welcome screen.',
    '',
    '**When to use**:',
    '- Toggle enabled, change top description, swap the up-to-5 highlighted channels.',
    '',
    '**`welcome_channels`** is the FULL replacement list (no PATCH-merge). Pass `null` for description to clear.',
    '',
    '**Returns**: `{description, welcome_channels}`.',
  ].join('\n'),
  inputSchema: {
    guild_id: GuildId.describe('Guild to modify'),
    enabled: z.boolean().optional(),
    welcome_channels: z
      .array(
        z.object({
          channel_id: ChannelId,
          description: z.string().min(1).max(50),
          emoji_id: z.string().nullable().optional(),
          emoji_name: z.string().nullable().optional(),
        }),
      )
      .max(5)
      .optional(),
    description: z.string().max(140).nullable().optional(),
    audit_reason: z
      .string()
      .min(1)
      .max(512)
      .optional()
      .describe('Reason recorded in audit log (X-Audit-Log-Reason header)'),
  },
  outputSchema: {
    description: z.string().nullable(),
    welcome_channels: z.array(
      z.object({
        channel_id: ChannelId,
        description: z.string(),
        emoji_id: z.string().nullable(),
        emoji_name: z.string().nullable(),
      }),
    ),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  handler: async (args, ctx) => {
    const body: Record<string, unknown> = {};
    if (args.enabled !== undefined) body.enabled = args.enabled;
    if (args.welcome_channels !== undefined) body.welcome_channels = args.welcome_channels;
    if (args.description !== undefined)
      body.description =
        args.description === null
          ? null
          : withAttributionField(args.description, ctx.caller, 'Updated', 140);
    const w = (await container.rest.patch(Routes.guildWelcomeScreen(args.guild_id), {
      body,
      reason: args.audit_reason,
    })) as RawWelcomeScreen;
    return dualResult({
      text: `Updated welcome screen for \`${args.guild_id}\` (${w.welcome_channels.length} channels).`,
      data: {
        description: w.description,
        welcome_channels: w.welcome_channels.map((c) => ({
          channel_id: c.channel_id,
          description: c.description,
          emoji_id: c.emoji_id,
          emoji_name: c.emoji_name,
        })),
      },
    });
  },
});
