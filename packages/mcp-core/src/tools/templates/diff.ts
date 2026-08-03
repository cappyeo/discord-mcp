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
  TemplateDriftSchema,
  TemplateSummarySchema,
  templateDrift,
  templateDriftUntrustedText,
} from './_lib/template.js';

type RawGuildRecord = Record<string, unknown>;

export default defineTool({
  name: 'templates_diff',
  category: 'templates',
  description: [
    '**Purpose**: Detect channel and role drift between a Guild Template snapshot and its source guild before `templates_sync`.',
    '',
    '**Safety**: The source guild ID must match `guild_id`; otherwise the tool refuses to read that guild. Raw names are returned only in fenced `untrusted_text`. It also compares matched-role permission bitfields, matched-channel settings present in both payloads, and mappable permission overwrites. Discord-managed bot/integration roles are excluded because Guild Templates do not serialize them. Missing optional fields or unmapped overwrite subjects require manual review rather than a false claim of equality.',
    '',
    '**Returns**: `{template, source_guild_matches, drift, untrusted_text}`. This tool is read-only and never syncs the template.',
  ].join('\n'),
  inputSchema: {
    guild_id: GuildId.describe('Guild expected to be the template source guild'),
    template_code: TemplateCode.describe('Guild Template code to compare'),
  },
  outputSchema: {
    template: TemplateSummarySchema,
    source_guild_matches: z.boolean(),
    drift: TemplateDriftSchema.nullable(),
    untrusted_text: z.string(),
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  idempotent: true,
  handler: async (args) => {
    const raw = (await container.rest.get(Routes.template(args.template_code))) as RawGuildTemplate;
    const template = summarizeTemplate(raw);
    const sourceGuildMatches = template.source_guild_id === args.guild_id;
    if (!sourceGuildMatches) {
      return dualResult({
        text: `Template \`${template.code}\` belongs to source guild \`${template.source_guild_id}\`, not \`${args.guild_id}\`; no guild inventory was read.`,
        data: {
          template,
          source_guild_matches: false,
          drift: null,
          untrusted_text: templateDriftUntrustedText({
            template_source_guild_id: template.source_guild_id,
          }),
        },
      });
    }

    const [currentChannels, currentRoles] = (await Promise.all([
      container.rest.get(Routes.guildChannels(args.guild_id)),
      container.rest.get(Routes.guildRoles(args.guild_id)),
    ])) as [RawGuildRecord[], RawGuildRecord[]];
    const { drift, details } = templateDrift(raw, currentChannels, currentRoles);
    const structuralDifferenceCount =
      drift.channels_added_since_snapshot_count +
      drift.channels_missing_from_guild_count +
      drift.roles_added_since_snapshot_count +
      drift.roles_missing_from_guild_count;
    const semanticDifferenceCount =
      drift.role_permission_difference_count +
      drift.channel_setting_difference_count +
      drift.permission_overwrite_difference_count;
    return dualResult({
      text: `Compared Guild Template \`${template.code}\` with \`${args.guild_id}\`: ${structuralDifferenceCount} structural difference(s), ${semanticDifferenceCount} permission/setting difference(s), and ${drift.unmapped_permission_overwrite_count} overwrite(s) requiring manual review. ${drift.sync_recommended ? 'Review and consider templates_sync.' : 'No comparable drift detected.'}`,
      data: {
        template,
        source_guild_matches: true,
        drift,
        untrusted_text: templateDriftUntrustedText(details),
      },
    });
  },
});
