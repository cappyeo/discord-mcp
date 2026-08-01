import { z } from 'zod';

const SNOWFLAKE_REGEX = /^\d{17,20}$/;

export const Snowflake = z
  .string()
  .regex(SNOWFLAKE_REGEX, 'Must be a 17-20 digit Discord snowflake');

export const ChannelId = Snowflake.brand<'ChannelId'>().describe('Discord channel ID (snowflake)');
export const GuildId = Snowflake.brand<'GuildId'>().describe('Discord guild (server) ID');
export const MessageId = Snowflake.brand<'MessageId'>().describe('Discord message ID');
export const UserId = Snowflake.brand<'UserId'>().describe('Discord user ID');
export const RoleId = Snowflake.brand<'RoleId'>().describe('Discord role ID');
export const ApplicationId = Snowflake.brand<'ApplicationId'>().describe('Discord application ID');
export const WebhookId = Snowflake.brand<'WebhookId'>().describe('Discord webhook ID');
export const EmojiId = Snowflake.brand<'EmojiId'>().describe('Discord custom emoji ID');
export const StickerId = Snowflake.brand<'StickerId'>().describe('Discord sticker ID');
export const ScheduledEventId = Snowflake.brand<'ScheduledEventId'>().describe(
  'Discord scheduled event ID',
);
export const EntitlementId = Snowflake.brand<'EntitlementId'>().describe('Discord entitlement ID');
export const SkuId = Snowflake.brand<'SkuId'>().describe('Discord SKU ID');
export const SubscriptionId =
  Snowflake.brand<'SubscriptionId'>().describe('Discord subscription ID');
export const IntegrationId = Snowflake.brand<'IntegrationId'>().describe('Discord integration ID');
export const AutoModRuleId = Snowflake.brand<'AutoModRuleId'>().describe('Discord AutoMod rule ID');
export const StageInstanceId = Snowflake.brand<'StageInstanceId'>().describe(
  'Discord stage instance ID',
);
export const SoundboardSoundId = Snowflake.brand<'SoundboardSoundId'>().describe(
  'Discord soundboard sound ID',
);
export const InteractionId = Snowflake.brand<'InteractionId'>().describe('Discord interaction ID');

// Invite codes are short base62-style strings, NOT snowflakes.
export const InviteCode = z
  .string()
  .min(1)
  .max(32)
  .brand<'InviteCode'>()
  .describe('Discord invite code (base62, NOT a snowflake)');

// Webhook tokens are long opaque secrets, NOT snowflakes. They live here in the
// brand registry alongside other Discord identifiers for ergonomic imports.
export const WebhookToken = z
  .string()
  .min(60)
  .max(100)
  .brand<'WebhookToken'>()
  .describe('Discord webhook token (secret - treat as credential, do not log)');

// Inferred branded types for compile-time safety:
export type ChannelId = z.infer<typeof ChannelId>;
export type GuildId = z.infer<typeof GuildId>;
export type MessageId = z.infer<typeof MessageId>;
export type UserId = z.infer<typeof UserId>;
export type RoleId = z.infer<typeof RoleId>;
