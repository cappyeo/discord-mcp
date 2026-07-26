export function createDebouncer<TArgs extends unknown[]>(
  fn: (...args: TArgs) => void,
  delayMs: number,
): (...args: TArgs) => void {
  let timer: NodeJS.Timeout | null = null;
  let lastArgs: TArgs | null = null;
  return (...args: TArgs) => {
    lastArgs = args;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (lastArgs !== null) {
        fn(...lastArgs);
        lastArgs = null;
      }
    }, delayMs);
  };
}

export interface KeyedDebouncer {
  call: (key: string) => void;
  cancelAll: () => void;
}

/**
 * Per-key, leading-edge debouncer: the first call for a key fires immediately,
 * further calls inside the window are coalesced into one trailing fire.
 * Keys are independent, so activity on one key never starves another.
 */
export function createKeyedDebouncer(fn: (key: string) => void, delayMs: number): KeyedDebouncer {
  const timers = new Map<string, NodeJS.Timeout>();
  const pending = new Set<string>();
  const arm = (key: string): void => {
    timers.set(
      key,
      setTimeout(() => {
        timers.delete(key);
        if (pending.delete(key)) {
          fn(key);
          arm(key);
        }
      }, delayMs),
    );
  };
  return {
    call(key: string) {
      if (timers.has(key)) {
        pending.add(key);
        return;
      }
      fn(key);
      arm(key);
    },
    cancelAll() {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      pending.clear();
    },
  };
}
