import { container } from '@sapphire/pieces';
import { Routes } from 'discord-api-types/v10';
import { z } from 'zod';
import { BOT_APPLICATION_READ_ACCESS } from '../../access/requirements.js';
import { resolveApplicationId } from '../_lib/application.js';
import { defineTool } from '../_lib/defineTool.js';
import { dualResult } from '../_lib/response.js';
import { ApplicationId, EmojiId } from '../_lib/snowflake.js';

interface RawAppEmojiList {
  items: RawAppEmoji[];
}
interface RawAppEmoji {
  id: string | null;
  name: string | null;
  animated?: boolean;
}

export default defineTool({
  name: 'app_emojis_list',
  category: 'app_emojis',
  access: BOT_APPLICATION_READ_ACCESS,
  description: [
    '**Purpose**: List custom emojis registered against the application (per-app, not per-guild; up to 2,000).',
    '',
    '**When to use**:',
    '- Inspect app-level emojis usable from any guild the bot is in.',
    '- Omit `application_id` to inspect the application belonging to the authenticated bot.',
    '',
    '**When NOT to use**:',
    '- Guild-scoped emojis → use `emojis_list_guild`.',
    '',
    '**Returns**: `{emojis:[{id, name, animated}], count}`.',
  ].join('\n'),
  inputSchema: {
    application_id: ApplicationId.optional().describe(
      'Application owning the emojis (omit to use the authenticated bot application)',
    ),
  },
  outputSchema: {
    emojis: z.array(
      z.object({
        id: EmojiId.nullable(),
        name: z.string().nullable(),
        animated: z.boolean(),
      }),
    ),
    count: z.number().int(),
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  idempotent: true,
  handler: async (args, ctx) => {
    const applicationId = await resolveApplicationId(
      container.rest,
      args.application_id,
      ctx?.signal,
    );
    const raw = (await container.rest.get(
      Routes.applicationEmojis(applicationId),
    )) as RawAppEmojiList;
    const items = raw.items ?? [];
    const emojis = items.map((e) => ({
      id: e.id,
      name: e.name,
      animated: e.animated ?? false,
    }));
    return dualResult({
      text: `**${emojis.length} application emoji(s)** for app \`${applicationId}\`.`,
      data: { emojis, count: emojis.length },
    });
  },
});
