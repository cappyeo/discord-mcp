type PageState = {
  done: boolean;
  lists: Record<string, boolean[]>;
};

type ProgressState = Record<string, PageState>;

// biome-ignore lint/complexity/noStaticOnlyClass: a single namespaced store keeps all island subscribers on one shared state.
export class TutorialProgressStore {
  private static readonly storageKey = 'discord-mcp-tutorial-progress';
  private static readonly pageKey = TutorialProgressStore.normalizePath(window.location.pathname);
  private static readonly state: ProgressState = {
    [TutorialProgressStore.pageKey]: { done: false, lists: {} },
    ...TutorialProgressStore.load(),
  };
  private static readonly subscribers = new Map<(done: boolean) => void, string>();

  public static initializeList(listKey: string, length: number): void {
    const current = TutorialProgressStore.pageState.lists[listKey];
    if (current?.length === length) return;

    TutorialProgressStore.pageState.lists[listKey] = Array.from({ length }, () => false);
    TutorialProgressStore.store();
  }

  public static getListItem(listKey: string, index: number): boolean {
    return TutorialProgressStore.pageState.lists[listKey]?.[index] ?? false;
  }

  public static setListItem(listKey: string, index: number, value: boolean): void {
    TutorialProgressStore.pageState.lists[listKey][index] = value;
    TutorialProgressStore.store();
  }

  public static getPageDone(path: string): boolean {
    return TutorialProgressStore.state[TutorialProgressStore.normalizePath(path)]?.done ?? false;
  }

  public static subscribePageDone(path: string, callback: (done: boolean) => void): () => void {
    TutorialProgressStore.subscribers.set(callback, path);
    callback(TutorialProgressStore.getPageDone(path));
    return () => TutorialProgressStore.subscribers.delete(callback);
  }

  private static get pageState(): PageState {
    return TutorialProgressStore.state[TutorialProgressStore.pageKey];
  }

  private static load(): ProgressState {
    try {
      const state = JSON.parse(localStorage.getItem(TutorialProgressStore.storageKey) ?? '{}');
      if (TutorialProgressStore.isValidState(state)) return state;
    } catch {
      // Storage may be unavailable in private browsing or blocked contexts.
    }
    return {};
  }

  private static isValidState(state: unknown): state is ProgressState {
    return (
      !!state &&
      typeof state === 'object' &&
      Object.values(state).every((page) => {
        if (!page || typeof page !== 'object' || !('done' in page) || !('lists' in page)) {
          return false;
        }

        return (
          typeof page.done === 'boolean' &&
          !!page.lists &&
          typeof page.lists === 'object' &&
          Object.values(page.lists).every(
            (list) => Array.isArray(list) && list.every((item) => typeof item === 'boolean'),
          )
        );
      })
    );
  }

  private static store(): void {
    const lists = Object.values(TutorialProgressStore.pageState.lists);
    TutorialProgressStore.pageState.done =
      lists.length > 0 && lists.every((list) => list.length > 0 && list.every(Boolean));

    for (const [callback, path] of TutorialProgressStore.subscribers) {
      callback(TutorialProgressStore.getPageDone(path));
    }

    try {
      localStorage.setItem(
        TutorialProgressStore.storageKey,
        JSON.stringify(TutorialProgressStore.state),
      );
    } catch {
      // Progress is optional enhancement; the tutorial still works without storage.
    }
  }

  private static normalizePath(path: string): string {
    return path.replace(/\/+$/, '') || '/';
  }
}
