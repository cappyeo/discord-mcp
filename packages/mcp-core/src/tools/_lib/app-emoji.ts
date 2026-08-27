import { z } from 'zod';

const MAX_APP_EMOJI_BYTES = 256 * 1024;
const MAX_BASE64_LENGTH = Math.ceil(MAX_APP_EMOJI_BYTES / 3) * 4;
const APP_EMOJI_NAME_RE = /^[A-Za-z0-9_]{2,32}$/;
const APP_EMOJI_DATA_URI_RE = /^data:image\/(jpeg|png|gif|webp|avif);base64,([A-Za-z0-9+/=]+)$/;
const BASE64_CHARS_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/** Discord application emoji names: 2-32 ASCII letters, digits, or underscores. */
export const AppEmojiName = z
  .string()
  .min(2, 'Emoji name must be at least 2 characters')
  .max(32, 'Emoji name must be at most 32 characters')
  .regex(APP_EMOJI_NAME_RE, 'Emoji name must match [A-Za-z0-9_]{2,32}');

/**
 * Discord application emoji image as a strict base64 data URI.
 * The decoded image payload must be no larger than 256 KiB.
 */
export const AppEmojiImage = z
  .string()
  .min(1, 'Image data URI must not be empty')
  .regex(
    APP_EMOJI_DATA_URI_RE,
    'Image must be a data URI for JPEG, PNG, GIF, WEBP, or AVIF using base64',
  )
  .superRefine((value, context) => {
    const match = APP_EMOJI_DATA_URI_RE.exec(value);
    if (match === null) return;

    const payload = match[2];
    if (payload === undefined) {
      context.addIssue({ code: 'custom', message: 'Image data must be strict base64' });
      return;
    }
    if (
      payload.length > MAX_BASE64_LENGTH ||
      payload.length % 4 === 1 ||
      !BASE64_CHARS_RE.test(payload)
    ) {
      context.addIssue({ code: 'custom', message: 'Image data must be strict base64' });
      return;
    }

    const decoded = Buffer.from(payload, 'base64');
    const canonical = decoded.toString('base64');
    const canonicalMatches = payload.includes('=')
      ? canonical === payload
      : canonical.replace(/=+$/, '') === payload;
    if (!canonicalMatches) {
      context.addIssue({ code: 'custom', message: 'Image data must be strict base64' });
      return;
    }
    if (decoded.byteLength > MAX_APP_EMOJI_BYTES) {
      context.addIssue({ code: 'custom', message: 'Decoded image must be at most 256 KiB' });
    }
  });

export const APP_EMOJI_MAX_BYTES = MAX_APP_EMOJI_BYTES;
