import { describe, expect, it } from 'vitest';
import {
  ApplicationId,
  AutoModRuleId,
  ChannelId,
  EmojiId,
  EntitlementId,
  GuildId,
  IntegrationId,
  InteractionId,
  InviteCode,
  MessageId,
  RoleId,
  ScheduledEventId,
  SkuId,
  Snowflake,
  SoundboardSoundId,
  StageInstanceId,
  StickerId,
  SubscriptionId,
  UserId,
  WebhookId,
} from './snowflake.js';

describe('Snowflake schemas', () => {
  it('accepts a 17-digit snowflake', () => {
    expect(Snowflake.safeParse('11223344556677889').success).toBe(true);
  });
  it('accepts a 20-digit snowflake', () => {
    expect(Snowflake.safeParse('11223344556677889900').success).toBe(true);
  });
  it('rejects a 16-digit string', () => {
    expect(Snowflake.safeParse('1122334455667788').success).toBe(false);
  });
  it('rejects a 21-digit string', () => {
    expect(Snowflake.safeParse('112233445566778899001').success).toBe(false);
  });
  it('rejects non-numeric content', () => {
    expect(Snowflake.safeParse('abc456789012345678').success).toBe(false);
  });
  it('exports branded ID variants with same shape', () => {
    for (const s of [ChannelId, GuildId, MessageId, UserId, RoleId]) {
      expect(s.safeParse('123456789012345678').success).toBe(true);
    }
  });
  it('exports Plan 7 brand types accepting valid snowflakes', () => {
    for (const s of [
      ApplicationId,
      WebhookId,
      EmojiId,
      StickerId,
      ScheduledEventId,
      EntitlementId,
      SkuId,
      SubscriptionId,
      IntegrationId,
      AutoModRuleId,
      StageInstanceId,
      SoundboardSoundId,
      InteractionId,
    ]) {
      expect(s.safeParse('123456789012345678').success).toBe(true);
      expect(s.safeParse('not-a-snowflake').success).toBe(false);
    }
  });
  it('InviteCode accepts URL-safe identifiers and rejects empty and oversize strings', () => {
    expect(InviteCode.safeParse('abc123').success).toBe(true);
    expect(InviteCode.safeParse('Abc_123-def').success).toBe(true);
    expect(InviteCode.safeParse('').success).toBe(false);
    expect(InviteCode.safeParse('x'.repeat(33)).success).toBe(false);
  });
  it.each([
    '.',
    '..',
    '../channels/123456789012345678',
    '%2e%2e',
    'code?query#fragment',
    'code\\suffix',
    'code\nsuffix',
  ])('rejects invite route syntax: %j', (code) => {
    expect(InviteCode.safeParse(code).success).toBe(false);
  });
});
