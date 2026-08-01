import { container } from '@sapphire/pieces';
import { Routes } from 'discord-api-types/v10';
import { z } from 'zod';
import { defineTool } from '../_lib/defineTool.js';
import { dualResult } from '../_lib/response.js';
import { ApplicationId } from '../_lib/snowflake.js';

interface RawRoleConnectionMetadata {
  key: string;
  name: string;
  description: string;
  type: number;
}

const RoleConnectionMetadataRecord = z.object({
  key: z
    .string()
    .min(1)
    .max(50)
    .regex(/^[a-z0-9_]+$/, 'lowercase a-z, 0-9, _ only'),
  name: z.string().min(1).max(100),
  name_localizations: z.record(z.string(), z.string()).nullable().optional(),
  description: z.string().min(1).max(200),
  description_localizations: z.record(z.string(), z.string()).nullable().optional(),
  type: z
    .number()
    .int()
    .min(1)
    .max(8)
    .describe(
      '1=INTEGER_LESS_THAN_OR_EQUAL, 2=INTEGER_GREATER_THAN_OR_EQUAL, 3=INTEGER_EQUAL, 4=INTEGER_NOT_EQUAL, 5=DATETIME_LESS_THAN_OR_EQUAL, 6=DATETIME_GREATER_THAN_OR_EQUAL, 7=BOOLEAN_EQUAL, 8=BOOLEAN_NOT_EQUAL',
    ),
});

export default defineTool({
  name: 'application_modify_role_connection_metadata',
  category: 'application',
  description: [
    '**Purpose**: Replace the application role-connection metadata records (max 5).',
    '',
    '**This is a wholesale replace** - any existing record not in `records` is removed.',
    '',
    '**Returns**: `{records, count}` after the update.',
  ].join('\n'),
  inputSchema: {
    application_id: ApplicationId.describe('Bot/app application ID'),
    records: z
      .array(RoleConnectionMetadataRecord)
      .max(5)
      .describe('Up to 5 metadata records - wholesale replace.'),
  },
  outputSchema: {
    records: z.array(
      z.object({
        key: z.string(),
        name: z.string(),
        description: z.string(),
        type: z.number().int(),
      }),
    ),
    count: z.number(),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  idempotent: true,
  handler: async (args) => {
    const raw = (await container.rest.put(
      Routes.applicationRoleConnectionMetadata(args.application_id),
      { body: args.records },
    )) as RawRoleConnectionMetadata[];
    const records = raw.map((r) => ({
      key: r.key,
      name: r.name,
      description: r.description,
      type: r.type,
    }));
    return dualResult({
      text: `Updated **${records.length} role-connection metadata record(s)**.`,
      data: { records, count: records.length },
    });
  },
});
