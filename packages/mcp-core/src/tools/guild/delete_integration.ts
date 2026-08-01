import { container } from '@sapphire/pieces';
import { Routes } from 'discord-api-types/v10';
import { z } from 'zod';
import { defineTool } from '../_lib/defineTool.js';
import { dualResult } from '../_lib/response.js';
import { GuildId, IntegrationId } from '../_lib/snowflake.js';

export default defineTool({
  name: 'guild_delete_integration',
  category: 'guild',
  preconditions: ['confirm_required'] as const,
  description: [
    '**Purpose**: Delete an integration from a guild. **DESTRUCTIVE - also disconnects associated webhooks.**',
    '',
    '**When to use**:',
    '- Remove a stale or compromised third-party integration.',
    '',
    '**Returns**: `{deleted, integration_id, guild_id}`.',
    '',
    '**Security**: gated by `ConfirmRequired`. Pass `__confirm:true` AND set `MCP_DRY_RUN=false` to actually delete.',
  ].join('\n'),
  inputSchema: {
    guild_id: GuildId.describe('Guild containing the integration'),
    integration_id: IntegrationId.describe('Integration to delete (IRREVERSIBLE)'),
    audit_reason: z
      .string()
      .min(1)
      .max(512)
      .optional()
      .describe('Reason recorded in audit log (X-Audit-Log-Reason header)'),
  },
  outputSchema: {
    deleted: z.literal(true),
    integration_id: IntegrationId,
    guild_id: GuildId,
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  handler: async (args) => {
    await container.rest.delete(Routes.guildIntegration(args.guild_id, args.integration_id), {
      reason: args.audit_reason,
    });
    return dualResult({
      text: `Deleted integration \`${args.integration_id}\` from guild \`${args.guild_id}\`.`,
      data: {
        deleted: true as const,
        integration_id: args.integration_id,
        guild_id: args.guild_id,
      },
    });
  },
});
