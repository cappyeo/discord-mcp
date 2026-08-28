import { container } from '@sapphire/pieces';
import { Routes } from 'discord-api-types/v10';
import { z } from 'zod';
import { GUILD_READ_ACCESS } from '../../access/requirements.js';
import { defineTool } from '../_lib/defineTool.js';
import { dualResult } from '../_lib/response.js';
import { GuildId, UserId } from '../_lib/snowflake.js';
import { wrapUntrusted } from '../_lib/untrusted.js';

interface RawGuild {
  id: string;
  name: string;
  icon: string | null;
  owner_id: string;
  member_count?: number;
  description: string | null;
  premium_tier: number;
  preferred_locale: string;
  features: string[];
}

export default defineTool({
  name: 'guild_get',
  category: 'guild',
  access: GUILD_READ_ACCESS,
  description:
    '**Purpose**: Fetch guild metadata.\n\n**When to use**: server overview; compute boost-tier-dependent caps.\n\n**Returns**: `{id, name, icon, owner_id, member_count, description, premium_tier, preferred_locale, features}`. Structured `name` and `description` remain raw server-owner data; the human-readable text response fences them.',
  inputSchema: {
    guild_id: GuildId.describe('Guild to fetch'),
  },
  outputSchema: {
    id: GuildId,
    name: z.string(),
    icon: z.string().nullable(),
    owner_id: UserId,
    member_count: z.number().int().optional(),
    description: z.string().nullable(),
    premium_tier: z.number().int(),
    preferred_locale: z.string(),
    features: z.array(z.string()),
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  idempotent: true,
  handler: async (args) => {
    const g = (await container.rest.get(Routes.guild(args.guild_id), {
      query: new URLSearchParams({ with_counts: 'true' }),
    })) as RawGuild;
    const wrappedName = wrapUntrusted(g.name, 'username');
    const wrappedDesc =
      g.description !== null ? wrapUntrusted(g.description, 'channel_topic') : '_(no description)_';
    const data: Record<string, unknown> = {
      id: g.id,
      name: g.name,
      icon: g.icon,
      owner_id: g.owner_id,
      description: g.description,
      premium_tier: g.premium_tier,
      preferred_locale: g.preferred_locale,
      features: g.features,
    };
    if (g.member_count !== undefined) data.member_count = g.member_count;
    return dualResult({
      text: `**Guild ${wrappedName}** (\`guild:${g.id}\`)\nOwner: \`user:${g.owner_id}\`\nMembers: ${g.member_count ?? '?'}\nDescription: ${wrappedDesc}\nFeatures: ${g.features.join(', ') || '_(none)_'}`,
      data,
    });
  },
});
