import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ValidationError } from '../errors/client.js';
import { compose, type MiddlewareContext, type ToolMiddleware } from './compose.js';
import { validateMiddleware } from './validate.js';

interface DummyTool {
  inputSchema: Record<string, z.ZodTypeAny>;
}

const tool: DummyTool = {
  inputSchema: {
    channel_id: z.string().regex(/^\d{17,20}$/, 'must be 17-20 digit snowflake'),
    content: z.string().min(1, 'required'),
  },
};

function ctx(
  args: unknown,
  mw: ToolMiddleware,
): {
  dispatch: (a: unknown) => Promise<unknown>;
  middlewareCtx: MiddlewareContext<unknown>;
} {
  const middlewareCtx: MiddlewareContext<unknown> = {
    tool: { name: 'messages_send', category: 'messages', idempotent: false },
    args,
    meta: new Map<string, unknown>([['toolPiece', tool]]),
  };
  const dispatch = compose([mw], async (c) => c.args);
  return { dispatch: () => dispatch(middlewareCtx), middlewareCtx };
}

describe('validateMiddleware', () => {
  it('passes through when no tool piece is attached', async () => {
    const { dispatch, middlewareCtx } = ctx({ value: 'unchanged' }, validateMiddleware());
    middlewareCtx.meta.delete('toolPiece');
    await expect(dispatch(undefined)).resolves.toEqual({ value: 'unchanged' });
  });

  it('passes parsed args through when valid', async () => {
    const { dispatch } = ctx(
      { channel_id: '112233445566778899', content: 'hi' },
      validateMiddleware(),
    );
    const result = await dispatch(undefined);
    expect(result).toEqual({ channel_id: '112233445566778899', content: 'hi' });
  });

  it('throws ValidationError for missing field', async () => {
    const { dispatch } = ctx({ channel_id: '1' }, validateMiddleware());
    await expect(dispatch(undefined)).rejects.toBeInstanceOf(ValidationError);
  });

  it('ValidationError issues include both bad fields', async () => {
    const { dispatch } = ctx({ channel_id: 'short', content: '' }, validateMiddleware());
    try {
      await dispatch(undefined);
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(ValidationError);
      const ve = e as ValidationError;
      const paths = ve.issues.map((i) => i.path);
      expect(paths).toContain('channel_id');
      expect(paths).toContain('content');
    }
  });

  it('validates fresh input on repeated calls and preserves defaults and stripping', async () => {
    const piece = {
      inputSchema: { content: z.string().min(1), tts: z.boolean().default(false) },
    };
    const dispatch = compose([validateMiddleware()], async (c) => c.args);
    const base = {
      tool: { name: 'messages_send', category: 'messages', idempotent: false },
      meta: new Map<string, unknown>([['toolPiece', piece]]),
    };
    const args = { content: 'first', extra: 'strip me' };
    await expect(dispatch({ ...base, args })).resolves.toEqual({ content: 'first', tts: false });
    expect(args).toEqual({ content: 'first', extra: 'strip me' });
    await expect(dispatch({ ...base, args: { content: 'second', tts: true } })).resolves.toEqual({
      content: 'second',
      tts: true,
    });
    await expect(dispatch({ ...base, args: { content: '' } })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it('uses each tool shape even when tool names match or the shape is replaced', async () => {
    const piece = { inputSchema: { value: z.string() } as Record<string, z.ZodTypeAny> };
    const middlewareCtx = {
      tool: { name: 'same_name', category: 'test', idempotent: true },
      args: { value: 'text' } as unknown,
      meta: new Map<string, unknown>([['toolPiece', piece]]),
    };
    const dispatch = compose([validateMiddleware()], async (c) => c.args);
    await expect(dispatch(middlewareCtx)).resolves.toEqual({ value: 'text' });
    piece.inputSchema = { value: z.number() };
    middlewareCtx.args = { value: 'text' };
    await expect(dispatch(middlewareCtx)).rejects.toBeInstanceOf(ValidationError);
    middlewareCtx.args = { value: 2 };
    await expect(dispatch(middlewareCtx)).resolves.toEqual({ value: 2 });
    middlewareCtx.meta.set('toolPiece', { inputSchema: { value: z.boolean() } });
    middlewareCtx.args = { value: 2 };
    await expect(dispatch(middlewareCtx)).rejects.toBeInstanceOf(ValidationError);
  });
});
