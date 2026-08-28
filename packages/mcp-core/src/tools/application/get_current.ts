import { container } from '@sapphire/pieces';
import { Routes } from 'discord-api-types/v10';
import { z } from 'zod';
import { BOT_APPLICATION_READ_ACCESS } from '../../access/requirements.js';
import { defineTool } from '../_lib/defineTool.js';
import { dualResult } from '../_lib/response.js';
import { ApplicationId, UserId } from '../_lib/snowflake.js';
import { wrapUntrusted } from '../_lib/untrusted.js';

interface RawApplication {
  id: string;
  name: string;
  description: string | null;
  icon: string | null;
  cover_image?: string | null;
  bot_public?: boolean;
  bot_require_code_grant?: boolean;
  flags?: number;
  tags?: string[];
  owner?: { id: string };
  custom_install_url?: string;
  interactions_endpoint_url?: string | null;
  role_connections_verification_url?: string | null;
}

export default defineTool({
  name: 'application_get_current',
  category: 'application',
  access: BOT_APPLICATION_READ_ACCESS,
  description:
    '**Purpose**: Fetch the bot/app application object (`/applications/@me`).\n\n**When to use**: confirm app identity; read flags, install URLs, tags, interaction endpoint, etc.\n\n**Returns**: projected application shape. `name` and `description` remain raw app-author data; `untrusted_text` provides a separately fenced copy.',
  inputSchema: {},
  outputSchema: {
    id: ApplicationId,
    name: z.string(),
    description: z.string().nullable(),
    icon: z.string().nullable(),
    cover_image: z.string().nullable().optional(),
    bot_public: z.boolean().optional(),
    bot_require_code_grant: z.boolean().optional(),
    flags: z.number().int().optional(),
    tags: z.array(z.string()).optional(),
    owner_id: UserId.optional(),
    custom_install_url: z.string().optional(),
    interactions_endpoint_url: z.string().nullable().optional(),
    role_connections_verification_url: z.string().nullable().optional(),
    untrusted_text: z.string(),
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  idempotent: true,
  handler: async () => {
    const a = (await container.rest.get(Routes.currentApplication())) as RawApplication;
    const wrapped = wrapUntrusted(
      JSON.stringify({ name: a.name, description: a.description }),
      'channel_topic',
    );
    const out: Record<string, unknown> = {
      id: a.id,
      name: a.name,
      description: a.description,
      icon: a.icon,
      untrusted_text: wrapped,
    };
    if (a.cover_image !== undefined) out.cover_image = a.cover_image;
    if (a.bot_public !== undefined) out.bot_public = a.bot_public;
    if (a.bot_require_code_grant !== undefined)
      out.bot_require_code_grant = a.bot_require_code_grant;
    if (a.flags !== undefined) out.flags = a.flags;
    if (a.tags !== undefined) out.tags = a.tags;
    if (a.owner !== undefined) out.owner_id = a.owner.id;
    if (a.custom_install_url !== undefined) out.custom_install_url = a.custom_install_url;
    if (a.interactions_endpoint_url !== undefined)
      out.interactions_endpoint_url = a.interactions_endpoint_url;
    if (a.role_connections_verification_url !== undefined)
      out.role_connections_verification_url = a.role_connections_verification_url;
    return dualResult({
      text: `Application \`${a.id}\` (name/description wrapped untrusted).`,
      data: out,
    });
  },
});
