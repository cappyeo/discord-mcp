import { z } from 'zod';

// Routes wraps its route builders with URL encoding; keep validated input raw.
export const ReactionEmoji = z
  .string()
  .min(1)
  .max(128)
  .refine(
    (value) => value !== '.' && value !== '..' && !/[%/\\?\p{Cc}\p{Cs}]/u.test(value),
    'Use a raw Unicode emoji or name:id, without URL encoding, path syntax, or invalid Unicode',
  );
