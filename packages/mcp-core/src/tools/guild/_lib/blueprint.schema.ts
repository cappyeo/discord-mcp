import { z } from 'zod';
import type { TemplateBlueprintSchema } from '../../templates/_lib/template.js';
import type { RecommendationCapability } from '../../templates/catalog/recommendation.js';

export const BLUEPRINT_PERMISSION_NAMES = [
  'VIEW_CHANNEL',
  'READ_MESSAGE_HISTORY',
  'SEND_MESSAGES',
  'ADD_REACTIONS',
  'EMBED_LINKS',
  'ATTACH_FILES',
  'USE_APPLICATION_COMMANDS',
  'CREATE_PUBLIC_THREADS',
  'SEND_MESSAGES_IN_THREADS',
  'CONNECT',
  'SPEAK',
  'STREAM',
  'USE_VAD',
  'USE_EMBEDDED_ACTIVITIES',
  'MANAGE_MESSAGES',
  'MANAGE_THREADS',
  'VIEW_AUDIT_LOG',
  'KICK_MEMBERS',
  'MODERATE_MEMBERS',
  'CREATE_EVENTS',
  'MANAGE_EVENTS',
  'MANAGE_CHANNELS',
  'MANAGE_ROLES',
  'MANAGE_GUILD',
  'ADMINISTRATOR',
] as const;

export type BlueprintPermissionName = (typeof BLUEPRINT_PERMISSION_NAMES)[number];

export const SymbolKey = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
const PermissionNameSchema = z.enum(BLUEPRINT_PERMISSION_NAMES);
const PermissionArraySchema = z.array(PermissionNameSchema);
const OverwriteSubjectSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('everyone') }).strict(),
  z.object({ kind: z.literal('bot') }).strict(),
  z.object({ kind: z.literal('role'), key: SymbolKey }).strict(),
]);
export const PermissionOverwriteSchema = z
  .object({
    subject: OverwriteSubjectSchema,
    allow: PermissionArraySchema,
    deny: PermissionArraySchema,
  })
  .strict();

const RoleSchema = z
  .object({
    key: SymbolKey,
    name: z.string().min(1).max(100),
    position: z.number().int().positive(),
    color: z.number().int().min(0).max(0xffffff),
    hoist: z.boolean(),
    mentionable: z.boolean(),
    permissions: PermissionArraySchema,
  })
  .strict();

const CategorySchema = z
  .object({
    key: SymbolKey,
    name: z.string().min(1).max(100),
    position: z.number().int().nonnegative(),
    private: z.boolean(),
    overwrites: z.array(PermissionOverwriteSchema),
  })
  .strict();

const ForumTagSchema = z
  .object({
    key: SymbolKey,
    name: z.string().min(1).max(20),
    moderated: z.boolean(),
    emoji_name: z.string().nullable(),
  })
  .strict();

const ChannelSchema = z
  .object({
    key: SymbolKey,
    name: z.string().min(1).max(100),
    type: z.enum(['text', 'voice', 'forum', 'stage']),
    parent_key: SymbolKey,
    position: z.number().int().nonnegative(),
    topic: z.string().max(4096).nullable(),
    slowmode_seconds: z.number().int().min(0).max(21_600),
    default_onboarding: z.boolean(),
    everyone_sendable: z.boolean(),
    forum_tags: z.array(ForumTagSchema).max(20),
    overwrites: z.array(PermissionOverwriteSchema),
  })
  .strict();

const OnboardingOptionSchema = z
  .object({
    key: SymbolKey,
    title: z.string().min(1).max(100),
    description: z.string().max(100),
    role_keys: z.array(SymbolKey),
    channel_keys: z.array(SymbolKey),
  })
  .strict();

const OnboardingPromptSchema = z
  .object({
    key: SymbolKey,
    type: z.union([z.literal(0), z.literal(1)]),
    title: z.string().min(1).max(100),
    required: z.boolean(),
    in_onboarding: z.boolean(),
    single_select: z.boolean(),
    options: z.array(OnboardingOptionSchema).min(1).max(25),
  })
  .strict();

const AutoModActionSchema = z
  .object({
    type: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
    alert_channel_key: SymbolKey.nullable(),
    duration_seconds: z.number().int().min(0).max(2_419_200).nullable(),
    custom_message: z.string().max(150).nullable(),
  })
  .strict();

const AutoModRuleSchema = z
  .object({
    key: SymbolKey,
    name: z.string().min(1).max(100),
    event_type: z.union([z.literal(1), z.literal(2)]),
    trigger_type: z.union([z.literal(1), z.literal(3), z.literal(4), z.literal(5), z.literal(6)]),
    keyword_filter: z.array(z.string().max(60)).max(1000),
    regex_patterns: z.array(z.string().max(260)).max(10),
    presets: z.array(z.union([z.literal(1), z.literal(2), z.literal(3)])).max(3),
    allow_list: z.array(z.string().max(60)).max(1000),
    mention_total_limit: z.number().int().min(0).max(50).nullable(),
    mention_raid_protection_enabled: z.boolean().nullable(),
    actions: z.array(AutoModActionSchema).min(1).max(3),
    exempt_role_keys: z.array(SymbolKey).max(20),
    exempt_channel_keys: z.array(SymbolKey).max(50),
    enabled: z.boolean(),
  })
  .strict();

const ComponentsV2PublicationSchema = z
  .object({
    key: SymbolKey,
    channel_key: SymbolKey,
    allowed_mentions: z.object({ parse: z.array(z.never()).max(0) }).strict(),
    components: z.array(z.unknown()).min(1).max(40),
  })
  .strict();

export const GuildBlueprintSchema = z
  .object({
    schema_version: z.literal('guild_blueprint.v1'),
    policy_version: z.literal('community-safe.v1'),
    profile: z.enum([
      'professional_community',
      'professional_gaming',
      'professional_technology',
      'professional_creative',
      'professional_roleplay',
    ]),
    design_capabilities: z.array(z.string()),
    guild: z
      .object({
        name: z.string().min(2).max(100),
        description: z.string().max(300),
        preferred_locale: z.string().min(2).max(20),
        verification_level: z.literal(2),
        default_message_notifications: z.literal(1),
        explicit_content_filter: z.literal(2),
        community: z
          .object({
            required: z.literal(true),
            rules_channel_key: SymbolKey,
            public_updates_channel_key: SymbolKey,
            safety_alerts_channel_key: SymbolKey,
          })
          .strict(),
        welcome_screen: z
          .object({
            enabled: z.literal(true),
            description: z.string().max(140),
            channel_keys: z.array(SymbolKey).min(1).max(5),
          })
          .strict(),
      })
      .strict(),
    structure_basis: z
      .object({
        source_interpretation: z.literal('verified_structural_signals_and_capability_modules'),
        primary_channel_count: z.number().int().nonnegative(),
        primary_category_count: z.number().int().nonnegative(),
        primary_role_count: z.number().int().nonnegative(),
        applied_signals: z.array(z.string()),
      })
      .strict(),
    roles: z.array(RoleSchema).min(3).max(16),
    role_order: z.array(SymbolKey).min(3).max(16),
    categories: z.array(CategorySchema).min(4).max(8),
    channels: z.array(ChannelSchema).min(12).max(32),
    onboarding: z
      .object({
        enabled: z.literal(true),
        mode: z.literal(1),
        default_channel_keys: z.array(SymbolKey).min(7),
        prompts: z.array(OnboardingPromptSchema).min(1).max(5),
        verification: z.literal('api_readback_then_fresh_member_client_check'),
      })
      .strict(),
    automod: z
      .object({
        rules: z.array(AutoModRuleSchema).min(1).max(8),
        verification: z.literal('read_after_write'),
      })
      .strict(),
    components_v2: z
      .object({
        flags: z.literal(32_768),
        validate_before_send: z.literal(true),
        resolve_channel_placeholders_before_send: z.literal(true),
        publications: z.array(ComponentsV2PublicationSchema).min(2).max(6),
      })
      .strict(),
    bot_boundary: z
      .object({
        always_required_permissions: PermissionArraySchema,
        conditional_requirements: z.array(
          z
            .object({
              permission: PermissionNameSchema,
              when: z.string(),
              reason: z.string(),
            })
            .strict(),
        ),
        generated_roles_must_remain_below_bot: z.literal(true),
        managed_roles_are_immutable: z.literal(true),
        target_identity_and_guild_must_be_verified: z.literal(true),
        auto_grant_permissions: z.literal(false),
      })
      .strict(),
    resolution: z
      .object({
        strategy: z.literal('resolve_from_target_guild_and_create_results'),
        source_template_ids_allowed: z.literal(false),
        channel_placeholder_format: z.literal('<#{{channel:<symbol_key>}}>'),
      })
      .strict(),
    safety: z
      .object({
        source_permissions_discarded: z.literal(true),
        source_overwrites_discarded: z.literal(true),
        severe_generated_role_permissions: z.literal(0),
        dangling_symbolic_references: z.literal(0),
        onboarding_requirements_met: z.literal(true),
        components_v2_pre_resolution_valid: z.literal(true),
      })
      .strict(),
  })
  .strict();

export type GuildBlueprint = z.infer<typeof GuildBlueprintSchema>;
export type TemplateBlueprint = z.infer<typeof TemplateBlueprintSchema>;

export interface VerifiedBlueprintSource {
  readonly code: string;
  readonly blueprint: TemplateBlueprint;
  readonly effective_capabilities: readonly RecommendationCapability[];
}

export interface CompileGuildBlueprintInput {
  readonly request: string;
  readonly requested_capabilities: readonly RecommendationCapability[];
  readonly primary: VerifiedBlueprintSource;
  readonly inspirations: readonly VerifiedBlueprintSource[];
}
