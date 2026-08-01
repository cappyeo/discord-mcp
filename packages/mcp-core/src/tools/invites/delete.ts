import { container } from '@sapphire/pieces';
import { Routes } from 'discord-api-types/v10';
import { z } from 'zod';
import { defineTool } from '../_lib/defineTool.js';
import { dualResult } from '../_lib/response.js';
import { InviteCode } from '../_lib/snowflake.js';

export default defineTool({
  name: 'invites_delete',
  category: 'invites',
  preconditions: ['confirm_required'] as const,
  description: [
    '**Purpose**: Revoke a Discord invite by code. **DESTRUCTIVE - IRREVERSIBLE.**',
    '',
    '**When to use**:',
    '- Cut off an over-shared or compromised invite link.',
    '',
    '**When NOT to use**:',
    '- To rotate without disrupting access → create a new invite first, then delete the old one.',
    '',
    '**Returns**: `{deleted, code}`. Pass `__confirm:true` AND set `MCP_DRY_RUN=false` to actually delete.',
  ].join('\n'),
  inputSchema: {
    code: InviteCode.describe('Invite code to revoke'),
    audit_reason: z
      .string()
      .min(1)
      .max(512)
      .optional()
      .describe('Reason recorded in audit log (X-Audit-Log-Reason header)'),
  },
  outputSchema: {
    deleted: z.literal(true),
    code: InviteCode,
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  handler: async (args) => {
    await container.rest.delete(Routes.invite(args.code), {
      reason: args.audit_reason,
    });
    return dualResult({
      text: `Deleted invite \`${args.code}\`.`,
      data: {
        deleted: true as const,
        code: args.code,
      },
    });
  },
});
