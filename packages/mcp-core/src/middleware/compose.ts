export interface MiddlewareToolInfo {
  readonly name: string;
  readonly category: string;
  readonly idempotent: boolean;
}

export interface MiddlewareContext<Args = unknown> {
  readonly tool: MiddlewareToolInfo;
  readonly args: Args;
  readonly meta: Map<string, unknown>;
  /** Caller cancellation signal, when the embedding has one. */
  readonly signal?: AbortSignal;
}

export type CallNext<Args = unknown, R = unknown> = (ctx: MiddlewareContext<Args>) => Promise<R>;

export interface ToolMiddleware {
  onCallTool?<Args, R>(ctx: MiddlewareContext<Args>, next: () => Promise<R>): Promise<R>;
}

export function compose<Args, R>(
  middlewares: readonly ToolMiddleware[],
  handler: CallNext<Args, R>,
): CallNext<Args, R> {
  return async (ctx: MiddlewareContext<Args>): Promise<R> => {
    let lastIndex = -1;
    const dispatch = async (i: number): Promise<R> => {
      if (i <= lastIndex) {
        throw new Error('next() called multiple times in the same middleware invocation');
      }
      lastIndex = i;
      const mw = middlewares[i];
      if (mw === undefined) {
        return handler(ctx);
      }
      if (mw.onCallTool === undefined) {
        return dispatch(i + 1);
      }
      return mw.onCallTool(ctx, () => dispatch(i + 1));
    };
    return dispatch(0);
  };
}
