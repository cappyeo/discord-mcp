import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AppEmojiImage, AppEmojiName } from './app-emoji.js';

describe('application emoji validators', () => {
  it('accepts supported image formats and valid names', () => {
    const image = `data:image/png;base64,${Buffer.from('tiny').toString('base64')}`;
    expect(AppEmojiName.safeParse('spark_01').success).toBe(true);
    expect(AppEmojiImage.safeParse(image).success).toBe(true);
    for (const mime of ['jpeg', 'png', 'gif', 'webp', 'avif']) {
      expect(
        AppEmojiImage.safeParse(image.replace('image/png', `image/${mime}`)).success,
        mime,
      ).toBe(true);
    }
  });

  it('rejects invalid names and unsupported image formats', () => {
    expect(AppEmojiName.safeParse('a').success).toBe(false);
    expect(AppEmojiName.safeParse('bad-name').success).toBe(false);
    expect(AppEmojiName.safeParse('éclair').success).toBe(false);
    expect(AppEmojiImage.safeParse('data:image/svg+xml;base64,AAAA').success).toBe(false);
  });

  it('rejects non-canonical base64 and payloads over 256 KiB decoded', () => {
    expect(AppEmojiImage.safeParse('data:image/png;base64,abcd===').success).toBe(false);
    const oversized = `data:image/png;base64,${Buffer.alloc(256 * 1024 + 1).toString('base64')}`;
    expect(AppEmojiImage.safeParse(oversized).success).toBe(false);
  });

  it('accepts the exact 256 KiB boundary but rejects one byte over it', () => {
    const atLimit = `data:image/png;base64,${Buffer.alloc(256 * 1024).toString('base64')}`;
    const overLimit = `data:image/png;base64,${Buffer.alloc(256 * 1024 + 1).toString('base64')}`;
    expect(AppEmojiImage.safeParse(atLimit).success).toBe(true);
    expect(AppEmojiImage.safeParse(overLimit).success).toBe(false);
  });

  it('accepts canonical unpadded base64 data URIs', () => {
    expect(AppEmojiImage.safeParse('data:image/png;base64,dGlueQ').success).toBe(true);
  });

  it('is usable as a tool input schema field', () => {
    const schema = z.object({ name: AppEmojiName, image: AppEmojiImage });
    expect(
      schema.safeParse({
        name: 'ok',
        image: `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8]).toString('base64')}`,
      }).success,
    ).toBe(true);
  });
});
