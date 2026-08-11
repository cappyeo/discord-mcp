import type { RecommendationCapability } from '../../templates/catalog/recommendation.js';
import type {
  BlueprintPermissionName,
  CompileGuildBlueprintInput,
  GuildBlueprint,
} from './blueprint.schema.js';
import { assertBlueprintSafe } from './blueprint.validation.js';

const PUBLIC_TEXT_ALLOW: BlueprintPermissionName[] = [
  'VIEW_CHANNEL',
  'READ_MESSAGE_HISTORY',
  'SEND_MESSAGES',
  'ADD_REACTIONS',
  'EMBED_LINKS',
  'ATTACH_FILES',
  'USE_APPLICATION_COMMANDS',
];
const READ_ONLY_ALLOW: BlueprintPermissionName[] = ['VIEW_CHANNEL', 'READ_MESSAGE_HISTORY'];
const READ_ONLY_DENY: BlueprintPermissionName[] = [
  'SEND_MESSAGES',
  'CREATE_PUBLIC_THREADS',
  'SEND_MESSAGES_IN_THREADS',
];
const LFG_ALLOW: BlueprintPermissionName[] = ['CREATE_PUBLIC_THREADS', 'SEND_MESSAGES_IN_THREADS'];
const PUBLIC_VOICE_ALLOW: BlueprintPermissionName[] = [
  'VIEW_CHANNEL',
  'CONNECT',
  'SPEAK',
  'STREAM',
  'USE_VAD',
  'USE_EMBEDDED_ACTIVITIES',
];
const STAFF_DENY: BlueprintPermissionName[] = [
  'VIEW_CHANNEL',
  'READ_MESSAGE_HISTORY',
  'SEND_MESSAGES',
  'CONNECT',
  'SPEAK',
];
const STAFF_ALLOW: BlueprintPermissionName[] = [
  'VIEW_CHANNEL',
  'READ_MESSAGE_HISTORY',
  'SEND_MESSAGES',
  'EMBED_LINKS',
  'ATTACH_FILES',
  'USE_APPLICATION_COMMANDS',
  'SEND_MESSAGES_IN_THREADS',
  'CONNECT',
  'SPEAK',
  'STREAM',
  'USE_VAD',
];
const BOT_PUBLIC_ALLOW: BlueprintPermissionName[] = [
  'VIEW_CHANNEL',
  'READ_MESSAGE_HISTORY',
  'SEND_MESSAGES',
  'EMBED_LINKS',
  'ATTACH_FILES',
];
const VIETNAMESE = /[ăâđêôơưáàảãạấầẩẫậắằẳẵặéèẻẽẹếềểễệíìỉĩịóòỏõọốồổỗộớờởỡợúùủũụứừửữựýỳỷỹỵ]/iu;

function localized(request: string) {
  const vi = VIETNAMESE.test(request) || /\b(tieng viet|viet nam|dung cho toi)\b/iu.test(request);
  return vi
    ? {
        locale: 'vi',
        names: {
          community: 'Cộng đồng chuyên nghiệp',
          gaming: 'Cộng đồng Gaming',
          technology: 'Cộng đồng Công nghệ',
          creative: 'Cộng đồng Sáng tạo',
          roleplay: 'Cộng đồng Roleplay',
        },
        descriptions: {
          community: 'Không gian cộng đồng thân thiện, an toàn và dễ tham gia.',
          gaming: 'Cộng đồng gaming để trò chuyện, tìm đồng đội và tham gia sự kiện.',
          technology: 'Nơi cùng học hỏi, xây dựng và chia sẻ về công nghệ.',
          creative: 'Không gian để sáng tạo, chia sẻ tác phẩm và cộng tác.',
          roleplay: 'Cộng đồng roleplay có tổ chức, nhập vai và hỗ trợ người chơi.',
        },
      }
    : {
        locale: 'en-US',
        names: {
          community: 'Professional Community',
          gaming: 'Gaming Community',
          technology: 'Technology Community',
          creative: 'Creative Community',
          roleplay: 'Roleplay Community',
        },
        descriptions: {
          community: 'A welcoming, safe, and easy-to-navigate community space.',
          gaming: 'A gaming community for conversation, team finding, and events.',
          technology: 'A place to learn, build, and share technology together.',
          creative: 'A space to create, share work, and collaborate.',
          roleplay: 'An organized roleplay community for play and member support.',
        },
      };
}

function role(
  key: string,
  name: string,
  position: number,
  color: number,
  permissions: BlueprintPermissionName[] = [],
  hoist = false,
) {
  return { key, name, position, color, hoist, mentionable: false, permissions };
}

function everyoneOverwrite(allow: BlueprintPermissionName[], deny: BlueprintPermissionName[] = []) {
  return { subject: { kind: 'everyone' as const }, allow: [...allow], deny: [...deny] };
}

function botOverwrite(allow: BlueprintPermissionName[]) {
  return { subject: { kind: 'bot' as const }, allow: [...allow], deny: [] };
}

function roleOverwrite(
  key: string,
  allow: BlueprintPermissionName[],
  deny: BlueprintPermissionName[] = [],
) {
  return { subject: { kind: 'role' as const, key }, allow: [...allow], deny: [...deny] };
}

function category(
  key: string,
  name: string,
  position: number,
  privateCategory: boolean,
  overwrites: GuildBlueprint['categories'][number]['overwrites'],
) {
  return { key, name, position, private: privateCategory, overwrites };
}

function channel(
  key: string,
  name: string,
  type: GuildBlueprint['channels'][number]['type'],
  parentKey: string,
  position: number,
  options: {
    readonly topic?: string;
    readonly slowmode?: number;
    readonly defaultOnboarding?: boolean;
    readonly everyoneSendable?: boolean;
    readonly forumTags?: GuildBlueprint['channels'][number]['forum_tags'];
    readonly overwrites?: GuildBlueprint['channels'][number]['overwrites'];
  } = {},
) {
  return {
    key,
    name,
    type,
    parent_key: parentKey,
    position,
    topic: options.topic ?? null,
    slowmode_seconds: options.slowmode ?? 0,
    default_onboarding: options.defaultOnboarding ?? false,
    everyone_sendable: options.everyoneSendable ?? false,
    forum_tags: options.forumTags ?? [],
    overwrites: options.overwrites ?? [],
  };
}

function profileFor(capabilities: ReadonlySet<RecommendationCapability>) {
  if (capabilities.has('roleplay')) return 'professional_roleplay' as const;
  if (capabilities.has('gaming') || capabilities.has('lfg') || capabilities.has('platform')) {
    return 'professional_gaming' as const;
  }
  if (capabilities.has('technology') || capabilities.has('learning')) {
    return 'professional_technology' as const;
  }
  if (capabilities.has('art') || capabilities.has('music')) {
    return 'professional_creative' as const;
  }
  return 'professional_community' as const;
}

function contentFor(locale: string, guildName: string) {
  if (locale === 'vi') {
    return {
      welcome: [
        { type: 10, content: `## Chào mừng đến với ${guildName}` },
        {
          type: 10,
          content:
            'Bắt đầu tại <#{{channel:rules}}>, sau đó dùng Onboarding để chọn nền tảng và sở thích.',
        },
        { type: 14, divider: true, spacing: 1 },
        { type: 10, content: 'Hãy tôn trọng nhau, giữ an toàn và cùng xây dựng cộng đồng.' },
      ],
      rules: [
        { type: 10, content: '## Nội quy cộng đồng' },
        {
          type: 10,
          content:
            '1. Tôn trọng mọi thành viên.\n2. Không spam, lừa đảo hoặc quấy rối.\n3. Dùng đúng kênh và giữ nội dung an toàn.\n4. Làm theo hướng dẫn của đội ngũ điều hành.',
        },
      ],
      announcement: [
        { type: 10, content: '## Trung tâm thông báo' },
        {
          type: 10,
          content: 'Các cập nhật chính thức, sự kiện và thay đổi quan trọng sẽ được đăng tại đây.',
        },
      ],
    };
  }
  return {
    welcome: [
      { type: 10, content: `## Welcome to ${guildName}` },
      {
        type: 10,
        content:
          'Start in <#{{channel:rules}}>, then use Onboarding to choose your platform and interests.',
      },
      { type: 14, divider: true, spacing: 1 },
      { type: 10, content: 'Respect others, stay safe, and help build the community.' },
    ],
    rules: [
      { type: 10, content: '## Community rules' },
      {
        type: 10,
        content:
          '1. Respect every member.\n2. No spam, scams, or harassment.\n3. Use the right channel and keep content safe.\n4. Follow moderator guidance.',
      },
    ],
    announcement: [
      { type: 10, content: '## Announcement center' },
      {
        type: 10,
        content: 'Official updates, events, and important changes will be published here.',
      },
    ],
  };
}
function container(components: unknown[], accentColor: number) {
  return [{ type: 17, accent_color: accentColor, components }];
}

export function compileGuildBlueprint(input: CompileGuildBlueprintInput): GuildBlueprint {
  const capabilities = new Set<RecommendationCapability>([
    ...input.requested_capabilities,
    ...input.primary.effective_capabilities,
    ...input.inspirations.flatMap((item) => item.effective_capabilities),
  ]);
  const profile = profileFor(capabilities);
  const copy = localized(input.request);
  const profileKey = profile.replace('professional_', '') as keyof typeof copy.names;
  const guildName = copy.names[profileKey];
  const guildDescription = copy.descriptions[profileKey];
  const gaming = profile === 'professional_gaming' || profile === 'professional_roleplay';
  const technology = profile === 'professional_technology';
  const creative = profile === 'professional_creative';
  const includeEvents = capabilities.has('events');
  const primaryHasForum = input.primary.blueprint.forum_channel_count > 0;
  const primaryHasStage = input.primary.blueprint.stage_channel_count > 0;

  const roles: GuildBlueprint['roles'] = [role('member', 'Member', 1, 0x95a5a6)];
  if (gaming) {
    for (const [key, name, color] of [
      ['pc', 'PC', 0x5865f2],
      ['playstation', 'PlayStation', 0x3498db],
      ['xbox', 'Xbox', 0x2ecc71],
      ['mobile', 'Mobile', 0x9b59b6],
      ['switch', 'Nintendo Switch', 0xe74c3c],
      ['lfg', 'Looking for Group', 0x1abc9c],
    ] as const) {
      roles.push(role(key, name, roles.length + 1, color));
    }
  }
  if (technology) {
    roles.push(role('developer', 'Developer', roles.length + 1, 0x3498db));
    roles.push(role('designer', 'Designer', roles.length + 1, 0xe056fd));
  }
  if (creative) {
    roles.push(role('artist', 'Artist', roles.length + 1, 0xe056fd));
    roles.push(role('musician', 'Musician', roles.length + 1, 0x9b59b6));
  }
  roles.push(
    role(
      'helper',
      'Helper',
      roles.length + 1,
      0x2ecc71,
      ['MANAGE_MESSAGES', 'MANAGE_THREADS'],
      true,
    ),
  );
  if (includeEvents) {
    roles.push(
      role(
        'event_host',
        'Event Host',
        roles.length + 1,
        0xf1c40f,
        ['CREATE_EVENTS', 'MANAGE_EVENTS'],
        true,
      ),
    );
  }
  roles.push(
    role(
      'moderator',
      'Moderator',
      roles.length + 1,
      0xe67e22,
      ['MANAGE_MESSAGES', 'MANAGE_THREADS', 'VIEW_AUDIT_LOG', 'KICK_MEMBERS', 'MODERATE_MEMBERS'],
      true,
    ),
  );

  const publicStaffOverwrites = [
    everyoneOverwrite(READ_ONLY_ALLOW, READ_ONLY_DENY),
    roleOverwrite('helper', BOT_PUBLIC_ALLOW),
    roleOverwrite('moderator', BOT_PUBLIC_ALLOW),
    botOverwrite(BOT_PUBLIC_ALLOW),
  ];
  const staffOverwrites = [
    everyoneOverwrite([], STAFF_DENY),
    roleOverwrite('member', [], STAFF_DENY),
    roleOverwrite('helper', STAFF_ALLOW),
    roleOverwrite('moderator', STAFF_ALLOW),
    botOverwrite(STAFF_ALLOW),
  ];
  const categories: GuildBlueprint['categories'] = [
    category('start_here', 'START HERE', 0, false, publicStaffOverwrites),
    category('community', 'COMMUNITY', 1, false, [everyoneOverwrite(PUBLIC_TEXT_ALLOW)]),
  ];
  if (gaming) {
    categories.push(
      category('gaming', profile === 'professional_roleplay' ? 'ROLEPLAY' : 'GAMING', 2, false, [
        everyoneOverwrite(PUBLIC_TEXT_ALLOW),
      ]),
    );
  }
  if (technology) {
    categories.push(
      category('technology', 'TECHNOLOGY', 2, false, [everyoneOverwrite(PUBLIC_TEXT_ALLOW)]),
    );
  }
  if (creative) {
    categories.push(
      category('creative', 'CREATIVE', 2, false, [everyoneOverwrite(PUBLIC_TEXT_ALLOW)]),
    );
  }
  if (includeEvents) {
    categories.push(
      category('events', 'EVENTS', categories.length, false, [
        everyoneOverwrite(PUBLIC_TEXT_ALLOW),
      ]),
    );
  }
  categories.push(
    category('voice', 'VOICE', categories.length, false, [everyoneOverwrite(PUBLIC_VOICE_ALLOW)]),
    category('staff', 'STAFF', categories.length + 1, true, staffOverwrites),
  );

  const channels: GuildBlueprint['channels'] = [
    channel('rules', 'rules', 'text', 'start_here', 0, {
      topic: 'Community rules and safety expectations.',
      defaultOnboarding: true,
    }),
    channel('welcome', 'welcome', 'text', 'start_here', 1, {
      topic: 'Start here and learn how the community works.',
      defaultOnboarding: true,
    }),
    channel('announcements', 'announcements', 'text', 'start_here', 2, {
      topic: 'Official community news and updates.',
      defaultOnboarding: true,
    }),
    channel('general', 'general', 'text', 'community', 0, {
      topic: 'Main community conversation.',
      slowmode: 3,
      defaultOnboarding: true,
      everyoneSendable: true,
    }),
    channel('introductions', 'introductions', 'text', 'community', 1, {
      topic: 'Introduce yourself to the community.',
      slowmode: 10,
      defaultOnboarding: true,
      everyoneSendable: true,
    }),
    channel('off_topic', 'off-topic', 'text', 'community', 2, {
      topic: 'Friendly conversation beyond the main topic.',
      slowmode: 5,
      defaultOnboarding: true,
      everyoneSendable: true,
    }),
    channel('media', 'media', 'text', 'community', 3, {
      topic: 'Share screenshots, clips, and community media.',
      slowmode: 10,
      defaultOnboarding: true,
      everyoneSendable: true,
    }),
    channel('bot_commands', 'bot-commands', 'text', 'community', 4, {
      topic: 'Use approved bot commands here.',
      slowmode: 3,
      defaultOnboarding: true,
      everyoneSendable: true,
    }),
  ];
  if (gaming) {
    channels.push(
      channel(
        'game_chat',
        profile === 'professional_roleplay' ? 'roleplay-chat' : 'game-chat',
        'text',
        'gaming',
        0,
        {
          topic: 'Discuss games, sessions, and strategies.',
          slowmode: 3,
          everyoneSendable: true,
        },
      ),
      channel('lfg', 'looking-for-group', 'forum', 'gaming', 1, {
        topic: 'Create a post to find teammates and organize a session.',
        slowmode: 10,
        everyoneSendable: true,
        forumTags: [
          { key: 'casual', name: 'Casual', moderated: false, emoji_name: '🎮' },
          { key: 'competitive', name: 'Competitive', moderated: false, emoji_name: '🏆' },
          { key: 'ranked', name: 'Ranked', moderated: false, emoji_name: '📈' },
          { key: 'new_players', name: 'New Players', moderated: false, emoji_name: '🌱' },
        ],
        overwrites: [everyoneOverwrite([...PUBLIC_TEXT_ALLOW, ...LFG_ALLOW])],
      }),
      channel('clips', 'clips-and-highlights', 'text', 'gaming', 2, {
        topic: 'Share gameplay clips and memorable moments.',
        slowmode: 15,
        everyoneSendable: true,
      }),
    );
  }
  if (technology) {
    channels.push(
      channel('tech_talk', 'tech-talk', 'text', 'technology', 0, {
        topic: 'Discuss engineering, products, and emerging technology.',
        slowmode: 3,
        everyoneSendable: true,
      }),
      channel('help_forum', 'help-and-questions', 'forum', 'technology', 1, {
        topic: 'Ask focused questions and share reproducible solutions.',
        slowmode: 10,
        everyoneSendable: true,
        forumTags: [
          { key: 'question', name: 'Question', moderated: false, emoji_name: '❓' },
          { key: 'solved', name: 'Solved', moderated: true, emoji_name: '✅' },
          { key: 'showcase', name: 'Showcase', moderated: false, emoji_name: '🚀' },
        ],
        overwrites: [everyoneOverwrite([...PUBLIC_TEXT_ALLOW, ...LFG_ALLOW])],
      }),
      channel('resources', 'resources', 'text', 'technology', 2, {
        topic: 'Curated guides, references, and learning resources.',
        overwrites: publicStaffOverwrites,
      }),
    );
  }
  if (creative) {
    channels.push(
      channel('showcase', 'showcase', 'forum', 'creative', 0, {
        topic: 'Share creative work and request constructive feedback.',
        slowmode: 10,
        everyoneSendable: true,
        forumTags: [
          { key: 'art', name: 'Art', moderated: false, emoji_name: '🎨' },
          { key: 'music', name: 'Music', moderated: false, emoji_name: '🎵' },
          { key: 'feedback', name: 'Feedback', moderated: false, emoji_name: '💬' },
        ],
        overwrites: [everyoneOverwrite([...PUBLIC_TEXT_ALLOW, ...LFG_ALLOW])],
      }),
      channel('collaboration', 'collaboration', 'text', 'creative', 1, {
        topic: 'Find collaborators and organize creative projects.',
        slowmode: 5,
        everyoneSendable: true,
      }),
    );
  }
  if (includeEvents) {
    channels.push(
      channel('events_calendar', 'events', 'text', 'events', 0, {
        topic: 'Upcoming community events and schedules.',
        overwrites: publicStaffOverwrites,
      }),
      channel('event_chat', 'event-chat', 'text', 'events', 1, {
        topic: 'Coordinate and discuss active community events.',
        slowmode: 3,
        everyoneSendable: true,
      }),
    );
  }
  channels.push(
    channel('lobby', 'Lobby', 'voice', 'voice', 0),
    channel('squad_one', gaming ? 'Squad 1' : 'Room 1', 'voice', 'voice', 1),
    channel('squad_two', gaming ? 'Squad 2' : 'Room 2', 'voice', 'voice', 2),
  );
  if (primaryHasStage && (includeEvents || creative)) {
    channels.push(channel('community_stage', 'Community Stage', 'stage', 'voice', 3));
  }
  channels.push(
    channel('afk', 'AFK', 'voice', 'voice', 4),
    channel('staff_chat', 'staff-chat', 'text', 'staff', 0, {
      topic: 'Private staff coordination.',
    }),
    channel('mod_log', 'mod-log', 'text', 'staff', 1, {
      topic: 'Private moderation and AutoMod alerts.',
      overwrites: [
        roleOverwrite('helper', [], ['VIEW_CHANNEL', 'READ_MESSAGE_HISTORY', 'SEND_MESSAGES']),
      ],
    }),
    channel('staff_voice', 'Staff Room', 'voice', 'staff', 2),
  );

  const defaultChannelKeys = [
    'rules',
    'welcome',
    'announcements',
    'general',
    'introductions',
    'off_topic',
    'media',
    'bot_commands',
  ];
  const prompts: GuildBlueprint['onboarding']['prompts'] = [];
  if (gaming) {
    prompts.push({
      key: 'platform',
      type: 0,
      title:
        copy.locale === 'vi' ? 'Bạn chơi trên nền tảng nào?' : 'Which platforms do you play on?',
      required: true,
      in_onboarding: true,
      single_select: false,
      options: [
        { key: 'pc', title: 'PC', description: 'PC players', role_keys: ['pc'], channel_keys: [] },
        {
          key: 'playstation',
          title: 'PlayStation',
          description: 'PlayStation players',
          role_keys: ['playstation'],
          channel_keys: [],
        },
        {
          key: 'xbox',
          title: 'Xbox',
          description: 'Xbox players',
          role_keys: ['xbox'],
          channel_keys: [],
        },
        {
          key: 'mobile',
          title: 'Mobile',
          description: 'Mobile players',
          role_keys: ['mobile'],
          channel_keys: [],
        },
        {
          key: 'switch',
          title: 'Nintendo Switch',
          description: 'Nintendo Switch players',
          role_keys: ['switch'],
          channel_keys: [],
        },
      ],
    });
  }
  const interestOptions: GuildBlueprint['onboarding']['prompts'][number]['options'] = [
    {
      key: 'conversation',
      title: copy.locale === 'vi' ? 'Trò chuyện cộng đồng' : 'Community conversation',
      description:
        copy.locale === 'vi' ? 'General và giới thiệu' : 'General chat and introductions',
      role_keys: ['member'],
      channel_keys: ['general', 'introductions'],
    },
    {
      key: 'media',
      title: copy.locale === 'vi' ? 'Hình ảnh và nội dung' : 'Media and content',
      description: copy.locale === 'vi' ? 'Ảnh, clip và tác phẩm' : 'Images, clips, and creations',
      role_keys: ['member'],
      channel_keys: ['media'],
    },
  ];
  if (gaming) {
    interestOptions.push({
      key: 'team_finding',
      title: copy.locale === 'vi' ? 'Tìm đồng đội' : 'Find teammates',
      description: copy.locale === 'vi' ? 'LFG và phòng đội' : 'LFG posts and squad voice',
      role_keys: ['member', 'lfg'],
      channel_keys: ['lfg', 'game_chat'],
    });
  }
  if (technology) {
    interestOptions.push({
      key: 'technology',
      title: copy.locale === 'vi' ? 'Công nghệ' : 'Technology',
      description:
        copy.locale === 'vi' ? 'Thảo luận và hỗ trợ kỹ thuật' : 'Technical discussion and support',
      role_keys: ['member', 'developer'],
      channel_keys: ['tech_talk', 'help_forum'],
    });
  }
  if (creative) {
    interestOptions.push({
      key: 'creative',
      title: copy.locale === 'vi' ? 'Sáng tạo' : 'Creative work',
      description: copy.locale === 'vi' ? 'Showcase và cộng tác' : 'Showcase and collaboration',
      role_keys: ['member', 'artist'],
      channel_keys: ['showcase', 'collaboration'],
    });
  }
  prompts.push({
    key: 'interests',
    type: 0,
    title: copy.locale === 'vi' ? 'Bạn muốn tham gia điều gì?' : 'What do you want to explore?',
    required: true,
    in_onboarding: true,
    single_select: false,
    options: interestOptions,
  });

  const messageContent = contentFor(copy.locale, guildName);
  const publications: GuildBlueprint['components_v2']['publications'] = [
    {
      key: 'welcome_card',
      channel_key: 'welcome',
      allowed_mentions: { parse: [] },
      components: container(messageContent.welcome, 0x5865f2),
    },
    {
      key: 'rules_card',
      channel_key: 'rules',
      allowed_mentions: { parse: [] },
      components: container(messageContent.rules, 0xe67e22),
    },
    {
      key: 'announcement_card',
      channel_key: 'announcements',
      allowed_mentions: { parse: [] },
      components: container(messageContent.announcement, 0x2ecc71),
    },
  ];

  const appliedSignals = ['professional_minimum', 'safe_permissions_regenerated'];
  if (primaryHasForum) appliedSignals.push('primary_uses_forum');
  if (input.primary.blueprint.voice_channel_count > 0) appliedSignals.push('primary_uses_voice');
  if (primaryHasStage && (includeEvents || creative)) appliedSignals.push('primary_uses_stage');
  if (input.inspirations.length > 0) appliedSignals.push('inspiration_capability_modules');

  const blueprint: GuildBlueprint = {
    schema_version: 'guild_blueprint.v1',
    policy_version: 'community-safe.v1',
    profile,
    design_capabilities: [...capabilities].sort(),
    guild: {
      name: guildName,
      description: guildDescription,
      preferred_locale: copy.locale,
      verification_level: 2,
      default_message_notifications: 1,
      explicit_content_filter: 2,
      community: {
        required: true,
        rules_channel_key: 'rules',
        public_updates_channel_key: 'announcements',
        safety_alerts_channel_key: 'mod_log',
      },
      welcome_screen: {
        enabled: true,
        description: guildDescription,
        channel_keys: ['rules', 'welcome', 'announcements', 'general', 'introductions'],
      },
    },
    structure_basis: {
      source_interpretation: 'verified_structural_signals_and_capability_modules',
      primary_channel_count: input.primary.blueprint.channel_count,
      primary_category_count: input.primary.blueprint.category_count,
      primary_role_count: input.primary.blueprint.role_count,
      applied_signals: appliedSignals,
    },
    roles,
    role_order: roles.map((item) => item.key),
    categories,
    channels,
    onboarding: {
      enabled: true,
      mode: 1,
      default_channel_keys: defaultChannelKeys,
      prompts,
      verification: 'api_readback_then_fresh_member_client_check',
    },
    automod: {
      rules: [
        {
          key: 'harmful_content',
          name: 'Harmful content',
          event_type: 1,
          trigger_type: 4,
          keyword_filter: [],
          regex_patterns: [],
          presets: [1, 2, 3],
          allow_list: [],
          mention_total_limit: null,
          mention_raid_protection_enabled: null,
          actions: [
            {
              type: 1,
              alert_channel_key: null,
              duration_seconds: null,
              custom_message: 'This message was blocked by the community safety policy.',
            },
            { type: 2, alert_channel_key: 'mod_log', duration_seconds: null, custom_message: null },
          ],
          exempt_role_keys: [],
          exempt_channel_keys: [],
          enabled: true,
        },
        {
          key: 'mention_raid',
          name: 'Mention raid protection',
          event_type: 1,
          trigger_type: 5,
          keyword_filter: [],
          regex_patterns: [],
          presets: [],
          allow_list: [],
          mention_total_limit: 5,
          mention_raid_protection_enabled: true,
          actions: [
            {
              type: 1,
              alert_channel_key: null,
              duration_seconds: null,
              custom_message: 'Too many mentions were blocked.',
            },
            { type: 2, alert_channel_key: 'mod_log', duration_seconds: null, custom_message: null },
            { type: 3, alert_channel_key: null, duration_seconds: 600, custom_message: null },
          ],
          exempt_role_keys: [],
          exempt_channel_keys: [],
          enabled: true,
        },
        {
          key: 'spam',
          name: 'Spam protection',
          event_type: 1,
          trigger_type: 3,
          keyword_filter: [],
          regex_patterns: [],
          presets: [],
          allow_list: [],
          mention_total_limit: null,
          mention_raid_protection_enabled: null,
          actions: [
            {
              type: 1,
              alert_channel_key: null,
              duration_seconds: null,
              custom_message: 'Spam was blocked by the community safety policy.',
            },
            { type: 2, alert_channel_key: 'mod_log', duration_seconds: null, custom_message: null },
          ],
          exempt_role_keys: [],
          exempt_channel_keys: [],
          enabled: true,
        },
      ],
      verification: 'read_after_write',
    },
    components_v2: {
      flags: 32_768,
      validate_before_send: true,
      resolve_channel_placeholders_before_send: true,
      publications,
    },
    bot_boundary: {
      always_required_permissions: [
        'VIEW_CHANNEL',
        'READ_MESSAGE_HISTORY',
        'SEND_MESSAGES',
        'MANAGE_CHANNELS',
        'MANAGE_ROLES',
        'MANAGE_GUILD',
        'MODERATE_MEMBERS',
      ],
      conditional_requirements: [
        {
          permission: 'ADMINISTRATOR',
          when: 'community_feature_is_missing',
          reason: 'Discord requires Administrator to enable the Community feature.',
        },
      ],
      generated_roles_must_remain_below_bot: true,
      managed_roles_are_immutable: true,
      target_identity_and_guild_must_be_verified: true,
      auto_grant_permissions: false,
    },
    resolution: {
      strategy: 'resolve_from_target_guild_and_create_results',
      source_template_ids_allowed: false,
      channel_placeholder_format: '<#{{channel:<symbol_key>}}>',
    },
    safety: {
      source_permissions_discarded: true,
      source_overwrites_discarded: true,
      severe_generated_role_permissions: 0,
      dangling_symbolic_references: 0,
      onboarding_requirements_met: true,
      components_v2_pre_resolution_valid: true,
    },
  };
  assertBlueprintSafe(blueprint);
  return blueprint;
}
