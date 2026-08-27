import { container } from '@sapphire/pieces';
import { Routes } from 'discord-api-types/v10';
import { z } from 'zod';
import { AppEmojiName } from '../_lib/app-emoji.js';
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
  name: 'app_emojis_modify',
  category: 'app_emojis',
  description: [
    '**Purpose**: Rename an application emoji.',
    '',
    '**When to use**:',
    '- Update the public-facing name of an app emoji.',
    '- Omit `application_id` to modify an emoji owned by the authenticated bot application.',
    '',
    '**When NOT to use**:',
    '- Replacing image bytes - Discord does not allow editing emoji bytes; create and verify a replacement with `app_emojis_create`, then remove the old one with confirmation via `app_emojis_delete`.',
    '',
    '**Returns**: `{id, name, animated}`.',
  ].join('\n'),
  inputSchema: {
    application_id: ApplicationId.optional().describe(
      'Application owning the emoji (omit to use the authenticated bot application)',
    ),
    emoji_id: EmojiId.describe('Emoji to modify'),
    name: AppEmojiName.describe('New emoji name (2-32 ASCII letters, digits, or underscores)'),
  },
  outputSchema: {
    id: EmojiId.nullable(),
    name: z.string().nullable(),
    animated: z.boolean(),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  handler: async (args, ctx) => {
    const name = AppEmojiName.parse(args.name);
    const applicationId = await resolveApplicationId(
      container.rest,
      args.application_id,
      ctx?.signal,
    );
    const body: Record<string, unknown> = { name };
    const e = (await container.rest.patch(Routes.applicationEmoji(applicationId, args.emoji_id), {
      body,
    })) as RawAppEmoji;
    return dualResult({
      text: `Modified app emoji ${e.name ?? '(unnamed)'} (\`${e.id ?? 'null'}\`).`,
      data: {
        id: e.id,
        name: e.name,
        animated: e.animated ?? false,
      },
    });
  },
});
