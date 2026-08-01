import { container } from '@sapphire/pieces';
import { Routes } from 'discord-api-types/v10';
import { z } from 'zod';
import { defineTool } from '../_lib/defineTool.js';
import { dualResult } from '../_lib/response.js';
import { ApplicationId } from '../_lib/snowflake.js';
import { wrapUntrusted } from '../_lib/untrusted.js';

interface RawApplication {
  id: string;
  name: string;
  description: string | null;
  icon: string | null;
  flags?: number;
}

export default defineTool({
  name: 'application_modify_current',
  category: 'application',
  description: [
    '**Purpose**: Edit the bot/app application object (`PATCH /applications/@me`).',
    '',
    '**Pass only fields you want to change.** All fields optional.',
    '',
    '**Returns**: updated `{id, name, description, icon, flags, untrusted_text}`. `name` and `description` remain raw; `untrusted_text` provides a separately fenced copy.',
  ].join('\n'),
  inputSchema: {
    description: z.string().max(400).optional(),
    icon: z.string().nullable().optional().describe('base64 image data or null'),
    cover_image: z.string().nullable().optional(),
    interactions_endpoint_url: z.string().url().nullable().optional(),
    role_connections_verification_url: z.string().url().nullable().optional(),
    install_params: z.record(z.string(), z.unknown()).optional(),
    integration_types_config: z.record(z.string(), z.unknown()).optional(),
    custom_install_url: z.string().url().optional(),
    tags: z.array(z.string().max(20)).max(5).optional(),
    flags: z.number().int().optional(),
    event_webhooks_url: z.string().url().nullable().optional(),
    event_webhooks_status: z.number().int().min(1).max(2).optional(),
    event_webhooks_types: z.array(z.string()).optional(),
  },
  outputSchema: {
    id: ApplicationId,
    name: z.string(),
    description: z.string().nullable(),
    icon: z.string().nullable(),
    flags: z.number().int().optional(),
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
    const passthrough = [
      'description',
      'icon',
      'cover_image',
      'interactions_endpoint_url',
      'role_connections_verification_url',
      'install_params',
      'integration_types_config',
      'custom_install_url',
      'tags',
      'flags',
      'event_webhooks_url',
      'event_webhooks_status',
      'event_webhooks_types',
    ] as const;
    for (const key of passthrough) {
      const v = (args as Record<string, unknown>)[key];
      if (v !== undefined) body[key] = v;
    }
    const a = (await container.rest.patch(Routes.currentApplication(), { body })) as RawApplication;
    const wrapped = wrapUntrusted(
      JSON.stringify({ name: a.name, description: a.description }),
      'channel_topic',
    );
    const out: Record<string, unknown> = {
      id: a.id,
      name: a.name,
      description: a.description,
      icon: a.icon,
      untrusted_text: wrapped,
    };
    if (a.flags !== undefined) out.flags = a.flags;
    return dualResult({
      text: `Modified application \`${a.id}\` (name/description wrapped untrusted).`,
      data: out,
    });
  },
});
