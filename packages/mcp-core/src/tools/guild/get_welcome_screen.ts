import { container } from '@sapphire/pieces';
import { Routes } from 'discord-api-types/v10';
import { z } from 'zod';
import { defineTool } from '../_lib/defineTool.js';
import { dualResult } from '../_lib/response.js';
import { ChannelId, GuildId } from '../_lib/snowflake.js';
import { wrapUntrusted } from '../_lib/untrusted.js';

interface RawWelcomeChannel {
  channel_id: string;
  description: string;
  emoji_id: string | null;
  emoji_name: string | null;
}

interface RawWelcomeScreen {
  description: string | null;
  welcome_channels: RawWelcomeChannel[];
}

export default defineTool({
  name: 'guild_get_welcome_screen',
  category: 'guild',
  description: [
    '**Purpose**: Fetch the configured Community welcome screen.',
    '',
    '**When to use**:',
    '- Inspect onboarding before tweaking it.',
    '',
    '**Returns**: `{description, welcome_channels:[{channel_id, description, emoji_id, emoji_name}], untrusted_text}`. Descriptions remain raw server-owner data; `untrusted_text` provides a separately fenced copy.',
  ].join('\n'),
  inputSchema: {
    guild_id: GuildId.describe('Guild to query'),
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
    untrusted_text: z.string(),
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  idempotent: true,
  handler: async (args) => {
    const w = (await container.rest.get(
      Routes.guildWelcomeScreen(args.guild_id),
    )) as RawWelcomeScreen;
    const wrapped = wrapUntrusted(
      JSON.stringify({
        description: w.description,
        welcome_channels_descriptions: w.welcome_channels.map((c) => ({
          channel_id: c.channel_id,
          description: c.description,
        })),
      }),
      'channel_topic',
    );
    return dualResult({
      text: `Welcome screen for \`${args.guild_id}\` (${w.welcome_channels.length} channels). Server-owner text is wrapped untrusted.`,
      data: {
        description: w.description,
        welcome_channels: w.welcome_channels.map((c) => ({
          channel_id: c.channel_id,
          description: c.description,
          emoji_id: c.emoji_id,
          emoji_name: c.emoji_name,
        })),
        untrusted_text: wrapped,
      },
    });
  },
});
