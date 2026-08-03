import { container } from '@sapphire/pieces';
import { Routes } from 'discord-api-types/v10';
import { z } from 'zod';
import { defineTool } from '../_lib/defineTool.js';
import { dualResult } from '../_lib/response.js';
import { GuildId } from '../_lib/snowflake.js';
import {
  type RawGuildTemplate,
  summarizeTemplate,
  TemplateCode,
  TemplateSummarySchema,
  templateUntrustedText,
} from './_lib/template.js';

export default defineTool({
  name: 'templates_modify',
  category: 'templates',
  description: [
    '**Purpose**: Update a Guild Template name and/or description without changing its snapshot.',
    '',
    '**Requires**: Discord `MANAGE_GUILD` permission. Use `templates_sync` when the source guild layout changed.',
    '',
    '**Returns**: `{template, untrusted_text}`.',
  ].join('\n'),
  inputSchema: {
    guild_id: GuildId.describe('Guild that owns the template'),
    template_code: TemplateCode.describe('Guild Template code to edit'),
    name: z.string().trim().min(1).max(100).optional().describe('Replacement template name'),
    description: z
      .string()
      .max(120)
      .nullable()
      .optional()
      .describe('Replacement description; null clears it'),
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
    idempotentHint: true,
    openWorldHint: true,
  },
  idempotent: true,
  handler: async (args) => {
    const body: Record<string, unknown> = {};
    if (args.name !== undefined) body.name = args.name;
    if (args.description !== undefined) body.description = args.description;
    const raw = (await container.rest.patch(
      Routes.guildTemplate(args.guild_id, args.template_code),
      {
        body,
        reason: args.audit_reason,
      },
    )) as RawGuildTemplate;
    const template = summarizeTemplate(raw);
    return dualResult({
      text: `Updated metadata for Guild Template \`${template.code}\`. Its snapshot was not changed.`,
      data: { template, untrusted_text: templateUntrustedText(raw) },
    });
  },
});
