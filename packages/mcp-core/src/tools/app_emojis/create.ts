import { container } from '@sapphire/pieces';
import { Routes } from 'discord-api-types/v10';
import { z } from 'zod';
import { AppEmojiImage, AppEmojiName } from '../_lib/app-emoji.js';
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
  name: 'app_emojis_create',
  category: 'app_emojis',
  description: [
    '**Purpose**: Upload a new application-scoped custom emoji (applications can own up to 2,000).',
    '',
    '**When to use**:',
    '- Register an emoji available wherever the bot is - independent of guild.',
    '- Omit `application_id` to register it on the authenticated bot application.',
    '',
    '**When NOT to use**:',
    '- Guild-only emoji → use `emojis_create`.',
    '',
    '**Upload requirements**: JPEG, PNG, GIF, WEBP, or AVIF; decoded image ≤ 256 KiB; 128×128 is recommended; name is 2-32 ASCII letters, digits, or underscores.',
    '',
    '**Example**: `{name:"spark", image:"data:image/png;base64,…"}` (application_id is optional for the current bot)',
    '',
    '**Returns**: `{id, name, animated}`.',
  ].join('\n'),
  inputSchema: {
    application_id: ApplicationId.optional().describe(
      'Application to attach the emoji to (omit to use the authenticated bot application)',
    ),
    name: AppEmojiName.describe('Emoji name (2-32 ASCII letters, digits, or underscores)'),
    image: AppEmojiImage.describe(
      'Emoji image as a JPEG, PNG, GIF, WEBP, or AVIF base64 data URI (max 256 KiB decoded)',
    ),
  },
  outputSchema: {
    id: EmojiId.nullable(),
    name: z.string().nullable(),
    animated: z.boolean(),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  handler: async (args, ctx) => {
    // Keep direct tool-piece invocations subject to the same domain checks as
    // the normal MCP validation middleware.
    AppEmojiName.parse(args.name);
    AppEmojiImage.parse(args.image);
    const applicationId = await resolveApplicationId(
      container.rest,
      args.application_id,
      ctx?.signal,
    );
    const e = (await container.rest.post(Routes.applicationEmojis(applicationId), {
      body: { name: args.name, image: args.image },
    })) as RawAppEmoji;
    return dualResult({
      text: `Created application emoji ${e.name ?? '(unnamed)'} (\`${e.id ?? 'null'}\`).`,
      data: {
        id: e.id,
        name: e.name,
        animated: e.animated ?? false,
      },
    });
  },
});
