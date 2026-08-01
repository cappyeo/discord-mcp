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
  name: 'app_emojis_modify',
  category: 'app_emojis',
  description: [
    '**Purpose**: Rename an application emoji.',
    '',
    '**When to use**:',
    '- Update the public-facing name of an app emoji.',
    '',
    '**When NOT to use**:',
    '- Replacing image bytes - Discord does not allow editing emoji bytes.',
    '',
    '**Returns**: `{id, name, animated}`.',
  ].join('\n'),
  inputSchema: {
    application_id: ApplicationId.describe('Application owning the emoji'),
    emoji_id: EmojiId.describe('Emoji to modify'),
    name: z.string().min(2).max(32).optional().describe('New emoji name (2-32 chars)'),
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
  handler: async (args) => {
    const body: Record<string, unknown> = {};
    if (args.name !== undefined) body.name = args.name;
    const e = (await container.rest.patch(
      Routes.applicationEmoji(args.application_id, args.emoji_id),
      { body },
    )) as RawAppEmoji;
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
