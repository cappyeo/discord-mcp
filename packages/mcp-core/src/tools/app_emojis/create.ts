import { container } from '@sapphire/pieces';
import { Routes } from 'discord-api-types/v10';
import { z } from 'zod';
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
    '**Purpose**: Upload a new application-scoped custom emoji.',
    '',
    '**When to use**:',
    '- Register an emoji available wherever the bot is - independent of guild.',
    '',
    '**When NOT to use**:',
    '- Guild-only emoji → use `emojis_create`.',
    '',
    '**Example**: `{application_id:"…", name:"spark", image:"data:image/png;base64,…"}`',
    '',
    '**Returns**: `{id, name, animated}`.',
  ].join('\n'),
  inputSchema: {
    application_id: ApplicationId.describe('Application to attach the emoji to'),
    name: z.string().min(2).max(32).describe('Emoji name (2-32 chars)'),
    image: z
      .string()
      .min(1)
      .describe('Emoji image as a base64 data URI (e.g. "data:image/png;base64,…")'),
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
  handler: async (args) => {
    const e = (await container.rest.post(Routes.applicationEmojis(args.application_id), {
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
