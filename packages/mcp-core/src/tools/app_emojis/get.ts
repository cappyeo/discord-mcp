import { container } from '@sapphire/pieces';
import { Routes } from 'discord-api-types/v10';
import { z } from 'zod';
import { resolveApplicationId } from '../_lib/application.js';
import { defineTool } from '../_lib/defineTool.js';
import { dualResult } from '../_lib/response.js';
import { ApplicationId, EmojiId } from '../_lib/snowflake.js';

interface RawAppEmoji {
  id: string | null;
  name: string | null;
  animated?: boolean;
}

export default defineTool({
  name: 'app_emojis_get',
  category: 'app_emojis',
  description: [
    '**Purpose**: Fetch a single application emoji.',
    '',
    '**When to use**:',
    '- Verify an app emoji exists; inspect its name/animated flag.',
    '- Omit `application_id` to inspect the application belonging to the authenticated bot.',
    '',
    '**Returns**: `{id, name, animated}`.',
  ].join('\n'),
  inputSchema: {
    application_id: ApplicationId.optional().describe(
      'Application owning the emoji (omit to use the authenticated bot application)',
    ),
    emoji_id: EmojiId.describe('Emoji to fetch'),
  },
  outputSchema: {
    id: EmojiId.nullable(),
    name: z.string().nullable(),
    animated: z.boolean(),
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
    const e = (await container.rest.get(
      Routes.applicationEmoji(applicationId, args.emoji_id),
    )) as RawAppEmoji;
    return dualResult({
      text: `App emoji ${e.name ?? '(unnamed)'} (\`${e.id ?? 'null'}\`)`,
      data: {
        id: e.id,
        name: e.name,
        animated: e.animated ?? false,
      },
    });
  },
});
