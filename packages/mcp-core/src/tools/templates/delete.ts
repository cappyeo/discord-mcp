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
  name: 'templates_delete',
  category: 'templates',
  preconditions: ['confirm_required'] as const,
  description: [
    '**Purpose**: Delete a Guild Template. **DESTRUCTIVE - IRREVERSIBLE.**',
    '',
    '**Requires**: Discord `MANAGE_GUILD` permission. This removes the template code; it does not change existing guilds created from it.',
    '',
    '**Returns**: `{deleted, template, untrusted_text}`.',
    '',
    '**Security**: gated by `ConfirmRequired`. Pass `__confirm:true` AND set `MCP_DRY_RUN=false` to actually delete.',
  ].join('\n'),
  inputSchema: {
    guild_id: GuildId.describe('Guild that owns the template'),
    template_code: TemplateCode.describe('Guild Template code to delete (IRREVERSIBLE)'),
    audit_reason: z
      .string()
      .min(1)
      .max(512)
      .optional()
      .describe('Reason recorded in Discord audit log'),
  },
  outputSchema: {
    deleted: z.literal(true),
    template: TemplateSummarySchema,
    untrusted_text: z.string(),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  handler: async (args) => {
    const raw = (await container.rest.delete(
      Routes.guildTemplate(args.guild_id, args.template_code),
      {
        reason: args.audit_reason,
      },
    )) as RawGuildTemplate;
    const template = summarizeTemplate(raw);
    return dualResult({
      text: `Deleted Guild Template \`${template.code}\` from \`${args.guild_id}\`.`,
      data: { deleted: true as const, template, untrusted_text: templateUntrustedText(raw) },
    });
  },
});
