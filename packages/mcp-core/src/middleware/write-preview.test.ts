import { describe, expect, it, vi } from 'vitest';
import { WritePreview } from '../errors/client.js';
import type { MiddlewareContext } from './compose.js';
import { writePreviewMiddleware } from './write-preview.js';

function context(readOnlyHint: boolean): MiddlewareContext<Record<string, unknown>> {
  return {
    tool: { name: 'channels_create_guild_channel', category: 'channels', idempotent: false },
    args: { guild_id: '111122223333444455', name: 'preview' },
    meta: new Map([['toolPiece', { annotations: { readOnlyHint } }]]),
  };
}

describe('writePreviewMiddleware', () => {
  it('preserves legacy writes in allow mode', async () => {
    const next = vi.fn().mockResolvedValue({ ok: true });

    await expect(
      writePreviewMiddleware('allow').onCallTool!(context(false), next),
    ).resolves.toEqual({
      ok: true,
    });
    expect(next).toHaveBeenCalledOnce();
  });

  it('blocks every mutating tool in preview mode before its handler', async () => {
    const next = vi.fn();

    await expect(
      writePreviewMiddleware('preview').onCallTool!(context(false), next),
    ).rejects.toMatchObject({
      code: 'WRITE_PREVIEW',
      tool: 'channels_create_guild_channel',
      preview: { guild_id: '111122223333444455', name: 'preview' },
    } satisfies Partial<WritePreview>);
    expect(next).not.toHaveBeenCalled();
  });

  it('allows read-only tools in preview mode', async () => {
    const next = vi.fn().mockResolvedValue({ ok: true });

    await expect(
      writePreviewMiddleware('preview').onCallTool!(context(true), next),
    ).resolves.toEqual({
      ok: true,
    });
    expect(next).toHaveBeenCalledOnce();
  });

  it('fails closed when a tool has no annotation metadata', async () => {
    const next = vi.fn();
    const ctx = context(false);
    ctx.meta.delete('toolPiece');

    await expect(writePreviewMiddleware('preview').onCallTool!(ctx, next)).rejects.toBeInstanceOf(
      WritePreview,
    );
    expect(next).not.toHaveBeenCalled();
  });
});
