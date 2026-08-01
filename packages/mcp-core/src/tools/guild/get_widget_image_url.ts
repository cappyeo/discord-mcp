import { z } from 'zod';
import { defineTool } from '../_lib/defineTool.js';
import { dualResult } from '../_lib/response.js';
import { GuildId } from '../_lib/snowflake.js';

const WIDGET_STYLES = ['shield', 'banner1', 'banner2', 'banner3', 'banner4'] as const;

export default defineTool({
  name: 'guild_get_widget_image_url',
  category: 'guild',
  description: [
    '**Purpose**: Synthesize a public widget PNG URL. **No REST call is performed** - the agent decides whether to fetch.',
    '',
    '**When to use**:',
    '- Embed a guild widget image on a webpage or in markdown.',
    '',
    '**When NOT to use**:',
    '- Want JSON data → use `guild_get_widget`. Want admin settings → use `guild_get_widget_settings`.',
    '',
    '**Returns**: `{url, style}`. The URL is `https://discord.com/api/guilds/{id}/widget.png?style={style}`.',
  ].join('\n'),
  inputSchema: {
    guild_id: GuildId.describe('Guild to render'),
    style: z
      .enum(WIDGET_STYLES)
      .optional()
      .describe(
        "Widget style: 'shield' (default, compact) or 'banner1'..'banner4' (large banner variants)",
      ),
  },
  outputSchema: {
    url: z.string().url(),
    style: z.enum(WIDGET_STYLES),
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  idempotent: true,
  handler: async (args) => {
    const style = args.style ?? 'shield';
    const url = `https://discord.com/api/guilds/${args.guild_id}/widget.png?style=${style}`;
    return dualResult({
      text: `Widget image URL for \`${args.guild_id}\` (style=${style}): ${url}`,
      data: { url, style },
    });
  },
});
