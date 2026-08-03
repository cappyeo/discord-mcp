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
  name: 'templates_sync',
  category: 'templates',
  description: [
    '**Purpose**: Replace one Guild Template snapshot with the current state of its source guild.',
    '',
    '**Requires**: Discord `MANAGE_GUILD` permission. This updates what future users receive from the template but does not change any existing guild.',
    '',
    '**Snapshot fidelity**: After sync, use `templates_diff` to verify comparable drift. Discord may omit some source channel types from its official template serialization; the diff reports those separately rather than treating sync as a complete source-guild clone.',
    '',
    '**Returns**: `{template, untrusted_text}`.',
  ].join('\n'),
  inputSchema: {
    guild_id: GuildId.describe('Source guild whose current state to snapshot'),
    template_code: TemplateCode.describe('Guild Template code to sync'),
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
    const raw = (await container.rest.put(Routes.guildTemplate(args.guild_id, args.template_code), {
      reason: args.audit_reason,
    })) as RawGuildTemplate;
    const template = summarizeTemplate(raw);
    return dualResult({
      text: `Synced Guild Template \`${template.code}\` from \`${args.guild_id}\`. No existing guild was changed.`,
      data: { template, untrusted_text: templateUntrustedText(raw) },
    });
  },
});
