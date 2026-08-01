import { AsyncLocalStorage } from 'node:async_hooks';

export interface ToolRequestContext {
  readonly requestId: string;
  readonly toolName: string;
  readonly transport: 'stdio' | 'http';
  readonly signal: AbortSignal;
  readonly progressToken?: string | number;
  readonly meta?: Map<string, unknown>;
}

const als = new AsyncLocalStorage<ToolRequestContext>();

export function runWithCtx<T>(ctx: ToolRequestContext, fn: () => Promise<T>): Promise<T> {
  return als.run(ctx, fn);
}

export function getCtx(): ToolRequestContext {
  const ctx = als.getStore();
  if (ctx === undefined) {
    throw new Error('No active tool request context - getCtx() called outside runWithCtx().');
  }
  return ctx;
}

export function tryGetCtx(): ToolRequestContext | undefined {
  return als.getStore();
}
