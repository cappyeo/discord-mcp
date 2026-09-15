import type { APIGuildForumTag } from 'discord-api-types/v10';
import { z } from 'zod';
import { ValidationError } from '../../errors/client.js';
import { Snowflake } from './snowflake.js';

// https://docs.discord.com/developers/resources/channel#forum-tag-object
export const ForumTag = z.object({
  id: Snowflake,
  name: z.string(),
  moderated: z.boolean(),
  emoji_id: Snowflake.nullable(),
  emoji_name: z.string().nullable(),
});

export const ChannelTagOutput = {
  available_tags: z
    .array(ForumTag)
    .optional()
    .describe(
      'Complete forum/media tags, including IDs, names, moderation and emoji fields, when returned by Discord',
    ),
  applied_tags: z
    .array(Snowflake)
    .optional()
    .describe('Tag IDs applied to a forum/media post, when returned by Discord'),
};

export interface ChannelTags {
  available_tags?: APIGuildForumTag[];
  applied_tags?: string[];
}

export function channelTags(channel: ChannelTags): ChannelTags {
  return {
    ...(channel.available_tags === undefined
      ? {}
      : {
          available_tags: channel.available_tags.map(
            ({ id, name, moderated, emoji_id, emoji_name }) => ({
              id,
              name,
              moderated,
              emoji_id,
              emoji_name,
            }),
          ),
        }),
    ...(channel.applied_tags === undefined ? {} : { applied_tags: channel.applied_tags }),
  };
}

export const ForumTagInput = ForumTag.partial()
  .extend({ name: z.string().max(20) })
  .refine(
    (tag) => tag.emoji_id == null || tag.emoji_name == null,
    'Set at most one of emoji_id and emoji_name to a non-null value',
  );

type TagUpdate = Omit<APIGuildForumTag, 'id'> & { id?: string };

export function prepareForumTags(
  current: unknown,
  requested: z.infer<typeof ForumTagInput>[],
  removeIds: string[],
): TagUpdate[] {
  const parsed = z.array(ForumTag).safeParse(current);
  const reject = (message: string): never => {
    throw new ValidationError([{ path: 'available_tags', message, code: 'custom' }]);
  };
  if (!parsed.success)
    return reject('Cannot read the complete current tag set; no tags were changed.');
  const existing = new Map(parsed.data.map((tag) => [tag.id, tag]));
  const retained = requested.flatMap((tag) => (tag.id === undefined ? [] : [tag.id]));
  if (new Set(retained).size !== retained.length || new Set(removeIds).size !== removeIds.length) {
    reject('Tag IDs must be unique.');
  }
  if (retained.some((id) => !existing.has(id)) || removeIds.some((id) => !existing.has(id))) {
    reject('Unknown tag ID; read channels_get again. Omit id only for a new tag.');
  }
  if (removeIds.some((id) => retained.includes(id))) {
    reject('A tag cannot be retained and removed in the same request.');
  }
  const missing = [...existing.keys()].filter(
    (id) => !retained.includes(id) && !removeIds.includes(id),
  );
  if (missing.length > 0) {
    reject(
      `Keep existing tag IDs or explicitly list them in remove_available_tag_ids: ${missing.join(', ')}`,
    );
  }
  return requested.map((tag) => {
    const old = tag.id === undefined ? undefined : existing.get(tag.id);
    return {
      ...(tag.id === undefined ? {} : { id: tag.id }),
      name: tag.name,
      moderated: tag.moderated ?? old?.moderated ?? false,
      emoji_id:
        tag.emoji_id !== undefined
          ? tag.emoji_id
          : tag.emoji_name != null
            ? null
            : (old?.emoji_id ?? null),
      emoji_name:
        tag.emoji_name !== undefined
          ? tag.emoji_name
          : tag.emoji_id != null
            ? null
            : (old?.emoji_name ?? null),
    };
  });
}

export function forumTagsMatch(
  current: APIGuildForumTag[],
  expected: TagUpdate[],
  actual: unknown,
): boolean {
  const parsed = z.array(ForumTag).safeParse(actual);
  if (!parsed.success || parsed.data.length !== expected.length) return false;
  if (new Set(parsed.data.map((tag) => tag.id)).size !== parsed.data.length) return false;
  const remaining = [...parsed.data];
  return expected.every((tag) => {
    const index = remaining.findIndex(
      (candidate) =>
        (tag.id === undefined
          ? !current.some((old) => old.id === candidate.id)
          : candidate.id === tag.id) &&
        candidate.name === tag.name &&
        candidate.moderated === tag.moderated &&
        candidate.emoji_id === tag.emoji_id &&
        candidate.emoji_name === tag.emoji_name,
    );
    if (index < 0) return false;
    remaining.splice(index, 1);
    return true;
  });
}
