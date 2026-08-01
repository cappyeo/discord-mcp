import { ValidationError } from '../../errors/client.js';

export interface CursorPayload {
  readonly after?: string;
  readonly before?: string;
  readonly limit: number;
  readonly filter_hash?: string;
}

export function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

export function decodeCursor(s: string): CursorPayload {
  try {
    const json = Buffer.from(s, 'base64url').toString('utf8');
    const parsed = JSON.parse(json) as unknown;
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof (parsed as Record<string, unknown>).limit !== 'number'
    ) {
      throw new Error('cursor missing required fields');
    }
    return parsed as CursorPayload;
  } catch {
    throw new ValidationError([
      {
        path: 'cursor',
        message: 'Invalid cursor - must be opaque base64url issued by a previous response.',
        code: 'invalid_cursor',
      },
    ]);
  }
}
