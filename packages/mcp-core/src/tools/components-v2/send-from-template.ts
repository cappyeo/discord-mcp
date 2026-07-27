import { container } from '@sapphire/pieces';
import { Routes } from 'discord-api-types/v10';
import { z } from 'zod';
import { DiscordNotFoundError, ValidationError } from '../../errors/client.js';
import { defineTool } from '../_lib/defineTool.js';
import { dualResult } from '../_lib/response.js';
import { ChannelId, MessageId } from '../_lib/snowflake.js';
import { interpolateTemplate } from './_lib/interpolate.js';
import { validateComponentsV2 } from './_lib/validator.js';
import { TEMPLATES } from './templates/index.js';

const IS_COMPONENTS_V2 = 1 << 15;

const KNOWN_TEMPLATES = [
  'announcement',
  'release_notes',
  'welcome_card',
  'poll_results',
  'incident_status',
] as const;

interface TemplateFile {
  name: string;
  description: string;
  variables: string[];
  components: unknown[];
}

export default defineTool({
  name: 'components_v2_send_from_template',
  category: 'components_v2',
  description:
    '**Purpose**: Apply variables to a built-in V2 template and send the result.\n\n**Templates v1**: announcement, release_notes, welcome_card, poll_results, incident_status. Each declares a `variables` list — pass values in `vars`.\n\n**Returns**: `{message_id, jump_url, template}`.',
  inputSchema: {
    channel_id: ChannelId,
    template: z.enum(KNOWN_TEMPLATES).describe('Built-in template name'),
    vars: z
      .record(z.string(), z.string())
      .describe('Variable substitutions for {{...}} placeholders'),
  },
  outputSchema: {
    message_id: MessageId,
    channel_id: ChannelId,
    jump_url: z.string().url(),
    template: z.string(),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  handler: async (args) => {
    // Registry lookup, not a filesystem read: the JSON is bundled into the
    // published artifact, where the old `__dirname`-relative path did not exist.
    if (!Object.hasOwn(TEMPLATES, args.template)) {
      throw new DiscordNotFoundError('template', args.template);
    }
    const parsed = TEMPLATES[args.template] as TemplateFile;
    const components = interpolateTemplate(parsed.components, args.vars);
    const validation = validateComponentsV2(components);
    if (!validation.valid) {
      throw new ValidationError(
        validation.issues.map((i) => ({ path: i.path, message: i.message, code: i.code })),
      );
    }
    const m = (await container.rest.post(Routes.channelMessages(args.channel_id), {
      body: { flags: IS_COMPONENTS_V2, components },
    })) as { id: string; channel_id: string; guild_id?: string };
    const jumpRoot = m.guild_id ?? '@me';
    return dualResult({
      text: `Sent template "${args.template}" as message ${m.id} to <#${m.channel_id}>.`,
      data: {
        message_id: m.id,
        channel_id: m.channel_id,
        jump_url: `https://discord.com/channels/${jumpRoot}/${m.channel_id}/${m.id}`,
        template: args.template,
      },
    });
  },
});
