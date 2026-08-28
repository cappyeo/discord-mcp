import { container } from '@sapphire/pieces';
import { z } from 'zod';
import { BOT_APPLICATION_READ_ACCESS } from '../../access/requirements.js';
import { defineTool } from '../_lib/defineTool.js';
import { dualResult } from '../_lib/response.js';
import { ApplicationId } from '../_lib/snowflake.js';

interface RawActivityInstance {
  application_id: string;
  instance_id: string;
  launch_id?: string;
  location?: Record<string, unknown>;
  users?: string[];
}

export default defineTool({
  name: 'application_get_activity_instance',
  category: 'application',
  access: BOT_APPLICATION_READ_ACCESS,
  description: [
    '**Purpose**: Fetch a running Activity instance by id (Discord Activities API).',
    '',
    '**Note**: `discord-api-types/v10` does not yet expose `Routes.applicationActivityInstance`, so this tool calls the raw path `/applications/{application.id}/activity-instances/{instance_id}`.',
    '',
    '**Returns**: `{application_id, instance_id, launch_id?, location?, users?}`.',
  ].join('\n'),
  inputSchema: {
    application_id: ApplicationId.describe('Bot/app application ID'),
    instance_id: z
      .string()
      .min(1)
      .max(64)
      .describe('Activity instance id (returned by the activity launch event)'),
  },
  outputSchema: {
    application_id: ApplicationId,
    instance_id: z.string(),
    launch_id: z.string().optional(),
    location: z.record(z.string(), z.unknown()).optional(),
    users: z.array(z.string()).optional(),
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  idempotent: true,
  handler: async (args) => {
    // No Routes helper for activity instances yet - call the path directly.
    const raw = (await container.rest.get(
      `/applications/${args.application_id}/activity-instances/${args.instance_id}`,
    )) as RawActivityInstance;
    const out: Record<string, unknown> = {
      application_id: raw.application_id,
      instance_id: raw.instance_id,
    };
    if (raw.launch_id !== undefined) out.launch_id = raw.launch_id;
    if (raw.location !== undefined) out.location = raw.location;
    if (raw.users !== undefined) out.users = raw.users;
    return dualResult({
      text: `Activity instance \`${raw.instance_id}\` (app \`${raw.application_id}\`).`,
      data: out,
    });
  },
});
