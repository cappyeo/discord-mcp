import type { REST } from '@discordjs/rest';
import { ChannelType, Routes } from 'discord-api-types/v10';
import { UserId } from '../../_lib/snowflake.js';
import type { BlueprintBindings } from './blueprint.execution.schema.js';
import type { GuildBlueprint } from './blueprint.schema.js';

export interface TargetGuild {
  readonly id: string;
  readonly name: string;
  readonly owner_id: string;
  readonly description: string | null;
  readonly preferred_locale: string;
  readonly features: string[];
  readonly verification_level: number;
  readonly default_message_notifications: number;
  readonly explicit_content_filter: number;
  readonly rules_channel_id: string | null;
  readonly public_updates_channel_id: string | null;
  readonly safety_alerts_channel_id: string | null;
}

export interface TargetRole {
  readonly id: string;
  readonly name: string;
  readonly color: number;
  readonly position: number;
  readonly permissions: string;
  readonly mentionable: boolean;
  readonly hoist: boolean;
  readonly managed: boolean;
}

export interface TargetOverwrite {
  readonly id: string;
  readonly type: number;
  readonly allow: string;
  readonly deny: string;
}

export interface TargetForumTag {
  readonly id?: string;
  readonly name: string;
  readonly moderated: boolean;
  readonly emoji_id: string | null;
  readonly emoji_name: string | null;
}

export interface TargetChannel {
  readonly id: string;
  readonly guild_id?: string;
  readonly name: string;
  readonly type: number;
  readonly position: number;
  readonly parent_id: string | null;
  readonly topic: string | null;
  readonly nsfw: boolean;
  readonly rate_limit_per_user: number;
  readonly bitrate?: number;
  readonly user_limit?: number;
  readonly permission_overwrites: TargetOverwrite[];
  readonly available_tags: TargetForumTag[];
}

export interface TargetBotMember {
  readonly user: { readonly id: string };
  readonly roles: string[];
}

export interface TargetAutoModRule {
  readonly id: string;
  readonly guild_id: string;
  readonly creator_id: string;
  readonly name: string;
  readonly event_type: number;
  readonly trigger_type: number;
  readonly trigger_metadata: Record<string, unknown>;
  readonly actions: Array<Record<string, unknown>>;
  readonly enabled: boolean;
  readonly exempt_roles: string[];
  readonly exempt_channels: string[];
}

export interface TargetOnboarding {
  readonly guild_id: string;
  readonly prompts: Array<Record<string, unknown>>;
  readonly default_channel_ids: string[];
  readonly enabled: boolean;
  readonly mode: number;
}

export interface TargetWelcomeScreen {
  readonly description: string | null;
  readonly welcome_channels: Array<{
    readonly channel_id: string;
    readonly description: string;
    readonly emoji_id: string | null;
    readonly emoji_name: string | null;
  }>;
}

export interface TargetMessage {
  readonly id: string;
  readonly channel_id: string;
  readonly guild_id?: string;
  readonly author?: { readonly id?: string };
  readonly flags?: number;
  readonly nonce?: string | number;
  readonly mention_everyone?: boolean;
  readonly mentions?: readonly unknown[];
  readonly mention_roles?: readonly string[];
  readonly components?: unknown[];
}

export interface BlueprintTargetSnapshot {
  readonly guild: TargetGuild;
  readonly bot: TargetBotMember;
  readonly roles: TargetRole[];
  readonly channels: TargetChannel[];
  readonly automod_rules: TargetAutoModRule[];
  readonly onboarding: TargetOnboarding | null;
  readonly welcome_screen: TargetWelcomeScreen | null;
  readonly recent_messages: Readonly<Record<string, readonly TargetMessage[]>>;
  readonly publication_history_complete: Readonly<Record<string, boolean>>;
}

export const BLUEPRINT_PUBLICATION_HISTORY_LIMIT = 1_000;
/** Discord exposes this immutable built-in rule in guild AutoMod listings. */
const DISCORD_VIRTUAL_AUTOMOD_RULE_ID = '1030554520465440818';
const BLUEPRINT_PUBLICATION_HISTORY_PAGE_SIZE = 100;

export class BlueprintTargetError extends Error {
  public override readonly name = 'BlueprintTargetError';

  public constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function assertTargetId(kind: string, expected: string, received: unknown): void {
  if (received !== expected) {
    throw new BlueprintTargetError(
      'TARGET_GUILD_MISMATCH',
      `${kind} response did not belong to the explicitly selected guild.`,
    );
  }
}

function assertTargetSnowflake(kind: string, received: unknown): void {
  if (!UserId.safeParse(received).success) {
    throw new BlueprintTargetError(
      'TARGET_INVALID_SNOWFLAKE',
      `${kind} response did not contain a valid Discord snowflake.`,
    );
  }
}

function publicationCandidateChannelIds(
  blueprint: GuildBlueprint,
  channels: readonly TargetChannel[],
  seedBindings?: BlueprintBindings,
): string[] {
  const desiredChannels = new Map(blueprint.channels.map((channel) => [channel.key, channel]));
  const ids = new Set<string>();
  for (const publication of blueprint.components_v2.publications) {
    const desired = desiredChannels.get(publication.channel_key);
    if (desired === undefined) continue;
    const type = channelType(desired.type);
    const matches = channels.filter(
      (channel) => channel.name === desired.name && channel.type === type,
    );
    if (matches.length === 1) ids.add(matches[0]!.id);
    const boundId = seedBindings?.channels[publication.channel_key];
    if (boundId !== undefined && channels.some((channel) => channel.id === boundId)) {
      ids.add(boundId);
    }
  }
  return [...ids].sort();
}

function statusCode(error: unknown): number | null {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === 'number' ? status : null;
}

function discordErrorCode(error: unknown): string | null {
  const candidate = error as {
    code?: unknown;
    rawError?: { code?: unknown };
    data?: { code?: unknown };
  } | null;
  const code = candidate?.code ?? candidate?.rawError?.code ?? candidate?.data?.code;
  return code === undefined || code === null ? null : String(code);
}

async function readWelcomeScreen(
  rest: REST,
  guildId: string,
  signal?: AbortSignal,
): Promise<TargetWelcomeScreen> {
  try {
    return (await rest.get(Routes.guildWelcomeScreen(guildId), { signal })) as TargetWelcomeScreen;
  } catch (error) {
    if (statusCode(error) === 404 && discordErrorCode(error) === '10069') {
      return { description: null, welcome_channels: [] };
    }
    throw error;
  }
}

async function readPublicationHistory(
  rest: REST,
  guildId: string,
  channelId: string,
  signal?: AbortSignal,
): Promise<{ messages: TargetMessage[]; complete: boolean }> {
  const messages: TargetMessage[] = [];
  let before: string | undefined;

  while (messages.length < BLUEPRINT_PUBLICATION_HISTORY_LIMIT) {
    const query = new URLSearchParams({
      limit: String(BLUEPRINT_PUBLICATION_HISTORY_PAGE_SIZE),
    });
    if (before !== undefined) query.set('before', before);
    const page = (await rest.get(Routes.channelMessages(channelId), {
      query,
      signal,
    })) as TargetMessage[];
    for (const message of page) assertTargetMessage(message, guildId, channelId);
    messages.push(...page);
    if (page.length < BLUEPRINT_PUBLICATION_HISTORY_PAGE_SIZE) {
      return { messages, complete: true };
    }

    const nextBefore = page.at(-1)?.id;
    if (nextBefore === undefined || nextBefore === before) {
      return { messages, complete: false };
    }
    before = nextBefore;
  }

  return { messages, complete: false };
}

function assertTargetMessage(
  message: TargetMessage,
  guildId: string,
  channelId: string,
  expectedMessageId?: string,
): void {
  if (message.channel_id !== channelId) {
    throw new BlueprintTargetError(
      'TARGET_CHANNEL_MISMATCH',
      'Message response did not belong to the requested channel.',
    );
  }
  if (expectedMessageId !== undefined && message.id !== expectedMessageId) {
    throw new BlueprintTargetError(
      'TARGET_MESSAGE_MISMATCH',
      'Message response did not match the checkpoint-bound message.',
    );
  }
  if (message.guild_id !== undefined) assertTargetId('Message', guildId, message.guild_id);
}

export function channelType(type: GuildBlueprint['channels'][number]['type']): number {
  switch (type) {
    case 'text':
      return ChannelType.GuildText;
    case 'voice':
      return ChannelType.GuildVoice;
    case 'forum':
      return ChannelType.GuildForum;
    case 'stage':
      return ChannelType.GuildStageVoice;
  }
}

/** Read the target state used by both preview and resume reconciliation. */
export async function readBlueprintTargetSnapshot(
  rest: REST,
  guildId: string,
  botId: string,
  blueprint: GuildBlueprint,
  seedBindings?: BlueprintBindings,
  signal?: AbortSignal,
): Promise<BlueprintTargetSnapshot> {
  const [guild, bot, roles, channels, automodRules] = (await Promise.all([
    rest.get(Routes.guild(guildId), {
      query: new URLSearchParams({ with_counts: 'true' }),
      signal,
    }),
    rest.get(Routes.guildMember(guildId, botId), { signal }),
    rest.get(Routes.guildRoles(guildId), { signal }),
    rest.get(Routes.guildChannels(guildId), { signal }),
    rest.get(Routes.guildAutoModerationRules(guildId), { signal }),
  ])) as [TargetGuild, TargetBotMember, TargetRole[], TargetChannel[], TargetAutoModRule[]];

  assertTargetId('Guild', guildId, guild.id);
  assertTargetId('Bot member', botId, bot.user.id);
  for (const channel of channels) {
    // This is the guild-scoped channel collection. Unlike role objects (which
    // do not carry guild_id), every channel returned here must identify the
    // selected guild before it can participate in reconciliation.
    assertTargetId('Channel', guildId, channel.guild_id);
  }
  for (const rule of automodRules) {
    assertTargetId('AutoMod rule', guildId, rule.guild_id);
    assertTargetSnowflake('AutoMod rule creator_id', rule.creator_id);
  }
  const mutableAutomodRules = automodRules.filter(
    (rule) => rule.id !== DISCORD_VIRTUAL_AUTOMOD_RULE_ID,
  );

  const community = guild.features.includes('COMMUNITY');
  const [onboarding, welcomeScreen] = community
    ? ((await Promise.all([
        rest.get(Routes.guildOnboarding(guildId), { signal }),
        readWelcomeScreen(rest, guildId, signal),
      ])) as [TargetOnboarding, TargetWelcomeScreen])
    : [null, null];
  if (onboarding !== null) assertTargetId('Onboarding', guildId, onboarding.guild_id);

  const messageEntries = await Promise.all(
    publicationCandidateChannelIds(blueprint, channels, seedBindings).map(async (channelId) => {
      const history = await readPublicationHistory(rest, guildId, channelId, signal);
      return [channelId, history] as const;
    }),
  );
  const messagesByChannel = new Map(
    messageEntries.map(([channelId, history]) => [channelId, [...history.messages]]),
  );
  const publicationHistoryComplete = Object.fromEntries(
    messageEntries.map(([channelId, history]) => [channelId, history.complete]),
  );
  if (seedBindings !== undefined) {
    const publications = new Map(
      blueprint.components_v2.publications.map((publication) => [publication.key, publication]),
    );
    await Promise.all(
      Object.entries(seedBindings.publications).map(async ([key, messageId]) => {
        const publication = publications.get(key);
        if (publication === undefined) return;
        const channelId = seedBindings.channels[publication.channel_key];
        if (
          channelId === undefined ||
          !channels.some((channel) => channel.id === channelId) ||
          messagesByChannel.get(channelId)?.some((message) => message.id === messageId)
        ) {
          return;
        }
        let message: TargetMessage;
        try {
          message = (await rest.get(Routes.channelMessage(channelId, messageId), {
            signal,
          })) as TargetMessage;
        } catch (error) {
          if (statusCode(error) === 404) return;
          throw error;
        }
        assertTargetMessage(message, guildId, channelId, messageId);
        const messages = messagesByChannel.get(channelId) ?? [];
        messages.push(message);
        messagesByChannel.set(channelId, messages);
      }),
    );
  }

  return {
    guild,
    bot,
    roles,
    channels: channels.map((channel) => ({
      ...channel,
      parent_id: channel.parent_id ?? null,
      topic: channel.topic ?? null,
      nsfw: channel.nsfw ?? false,
      rate_limit_per_user: channel.rate_limit_per_user ?? 0,
      permission_overwrites: channel.permission_overwrites ?? [],
      available_tags: channel.available_tags ?? [],
    })),
    automod_rules: mutableAutomodRules,
    onboarding,
    welcome_screen: welcomeScreen,
    recent_messages: Object.fromEntries(messagesByChannel),
    publication_history_complete: publicationHistoryComplete,
  };
}
