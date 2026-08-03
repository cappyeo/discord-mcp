import { container } from '@sapphire/pieces';
import { Routes } from 'discord-api-types/v10';
import { z } from 'zod';
import { defineTool } from '../_lib/defineTool.js';
import { dualResult } from '../_lib/response.js';
import { GuildId } from '../_lib/snowflake.js';
import {
  type RawGuildTemplate,
  summarizeTemplate,
  TemplateSummarySchema,
  templateUntrustedText,
} from './_lib/template.js';

export default defineTool({
  name: 'templates_create',
  category: 'templates',
  description: [
    "**Purpose**: Snapshot the caller bot's current guild layout as a new Discord Guild Template.",
    '',
    '**Requires**: Discord `MANAGE_GUILD` permission. The template is a shareable snapshot of channels, roles, and settings; inspect it before sharing its `use_url`.',
    '',
    '**Returns**: `{template, untrusted_text}`.',
  ].join('\n'),
  inputSchema: {
    guild_id: GuildId.describe('Guild to snapshot'),
    name: z.string().trim().min(1).max(100).describe('Template name (1-100 characters)'),
    description: z
      .string()
      .max(120)
      .nullable()
      .optional()
      .describe('Optional template description (up to 120 characters)'),
    audit_reason: z
      .string()
      .min(1)
      .max(512)
      .optional()
      .describe('Reason recorded in Discord audit log'),
  },
  outputSchema: {
    template: TemplateSummarySchema,
    untrusted_text: z.string(),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  handler: async (args) => {
    const body: Record<string, unknown> = { name: args.name };
    if (args.description !== undefined) body.description = args.description;
    const raw = (await container.rest.post(Routes.guildTemplates(args.guild_id), {
      body,
      reason: args.audit_reason,
    })) as RawGuildTemplate;
    const template = summarizeTemplate(raw);
    return dualResult({
      text: `Created Guild Template \`${template.code}\` for \`${args.guild_id}\`. Share its use URL only after reviewing the snapshot.`,
      data: { template, untrusted_text: templateUntrustedText(raw) },
    });
  },
});
