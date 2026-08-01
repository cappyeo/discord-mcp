import { container } from '@sapphire/pieces';
import { Routes } from 'discord-api-types/v10';
import { z } from 'zod';
import { defineTool } from '../_lib/defineTool.js';
import { dualResult } from '../_lib/response.js';
import { ApplicationId, EntitlementId } from '../_lib/snowflake.js';

export default defineTool({
  name: 'entitlements_delete_test',
  category: 'monetization',
  preconditions: ['confirm_required'] as const,
  description: [
    '**Purpose**: Delete a test entitlement (dev tool). **DESTRUCTIVE - IRREVERSIBLE.**',
    '',
    '**Returns**: `{deleted, application_id, entitlement_id}`.',
    '',
    '**Security**: gated by `ConfirmRequired`. Pass `__confirm:true` AND set `MCP_DRY_RUN=false`.',
  ].join('\n'),
  inputSchema: {
    application_id: ApplicationId.describe('Your application/bot ID'),
    entitlement_id: EntitlementId.describe('Test entitlement to delete (IRREVERSIBLE)'),
  },
  outputSchema: {
    deleted: z.literal(true),
    application_id: ApplicationId,
    entitlement_id: EntitlementId,
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  handler: async (args) => {
    await container.rest.delete(Routes.entitlement(args.application_id, args.entitlement_id));
    return dualResult({
      text: `Deleted test entitlement \`${args.entitlement_id}\`.`,
      data: {
        deleted: true as const,
        application_id: args.application_id,
        entitlement_id: args.entitlement_id,
      },
    });
  },
});
