import { container } from '@sapphire/pieces';
import { Routes } from 'discord-api-types/v10';
import { z } from 'zod';
import { defineTool } from '../_lib/defineTool.js';
import { STICKER_FORMAT_TYPE } from '../_lib/discord-enums.js';
import { dualResult } from '../_lib/response.js';
import { GuildId, StickerId } from '../_lib/snowflake.js';

interface RawSticker {
  id: string;
  name: string;
  description: string | null;
  tags: string;
  format_type: number;
  available?: boolean;
}

const DATA_URI_RE = /^data:([^;,]+);base64,(.+)$/;

function parseDataUri(uri: string): { mime: string; bytes: Buffer } {
  const m = DATA_URI_RE.exec(uri);
  if (m === null) {
    throw new Error('file_data must be a base64 data URI (e.g. "data:image/png;base64,…")');
  }
  return { mime: m[1] as string, bytes: Buffer.from(m[2] as string, 'base64') };
}

function extensionFor(mime: string, format: number): string {
  if (mime.includes('png')) return 'png';
  if (mime.includes('apng')) return 'png';
  if (mime.includes('json') || format === 3) return 'json'; // LOTTIE
  if (mime.includes('gif')) return 'gif';
  return 'bin';
}

export default defineTool({
  name: 'stickers_create_guild_sticker',
  category: 'stickers',
  description: [
    '**Purpose**: Upload a new custom sticker to a guild (multipart).',
    '',
    '**When to use**:',
    '- Programmatic onboarding of brand stickers.',
    '',
    '**When NOT to use**:',
    '- Modify existing sticker → use `stickers_modify_guild_sticker`.',
    "- Format mismatch - Discord rejects payload that doesn't match `file_format`.",
    '',
    '**Example**: `{guild_id:"…", name:"WaveHi", description:"a wave", tags:"wave,hello", file_format:1, file_data:"data:image/png;base64,…"}`',
    '',
    '**Returns**: `{id, name, description, tags, format_type, available}`. File MUST be a base64 data URI.',
  ].join('\n'),
  inputSchema: {
    guild_id: GuildId.describe('Guild to attach the sticker to'),
    name: z.string().min(2).max(30).describe('Sticker name (2-30 chars)'),
    description: z.string().max(100).describe('Sticker description (max 100 chars)'),
    tags: z.string().min(1).max(200).describe('Autocomplete tags (max 200 chars)'),
    file_format: z
      .union([
        z.literal(STICKER_FORMAT_TYPE[0]),
        z.literal(STICKER_FORMAT_TYPE[1]),
        z.literal(STICKER_FORMAT_TYPE[2]),
        z.literal(STICKER_FORMAT_TYPE[3]),
      ])
      .describe('1=PNG, 2=APNG, 3=LOTTIE, 4=GIF'),
    file_data: z
      .string()
      .min(1)
      .describe('Sticker file as a base64 data URI (e.g. "data:image/png;base64,…")'),
    audit_reason: z
      .string()
      .min(1)
      .max(512)
      .optional()
      .describe('Reason recorded in audit log (X-Audit-Log-Reason header)'),
  },
  outputSchema: {
    id: StickerId,
    name: z.string(),
    description: z.string().nullable(),
    tags: z.string(),
    format_type: z.number().int(),
    available: z.boolean(),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  handler: async (args) => {
    const { mime, bytes } = parseDataUri(args.file_data);
    const ext = extensionFor(mime, args.file_format);
    const s = (await container.rest.post(Routes.guildStickers(args.guild_id), {
      appendToFormData: true,
      body: {
        name: args.name,
        description: args.description,
        tags: args.tags,
      },
      files: [
        {
          key: 'file',
          name: `sticker.${ext}`,
          contentType: mime,
          data: bytes,
        },
      ],
      reason: args.audit_reason,
    })) as RawSticker;
    return dualResult({
      text: `Created guild sticker ${s.name} (\`sticker:${s.id}\`).`,
      data: {
        id: s.id,
        name: s.name,
        description: s.description,
        tags: s.tags,
        format_type: s.format_type,
        available: s.available ?? true,
      },
    });
  },
});
