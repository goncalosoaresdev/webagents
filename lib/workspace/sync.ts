import type { TaskDetail } from './contracts.ts';

export interface TaskReader {
  task(id: string, after?: number, signal?: AbortSignal): Promise<TaskDetail>;
}

/** Drain every page, preserving already received events across reconnects. */
export async function readTask(
  reader: TaskReader,
  id: string,
  previous?: TaskDetail,
  signal?: AbortSignal,
): Promise<TaskDetail> {
  let cursor = previous?.task.id === id ? previous.nextSequence : 0;
  const events = new Map(
    (previous?.task.id === id ? previous.events : []).map((event) => [
      event.sequence,
      event,
    ]),
  );
  while (true) {
    signal?.throwIfAborted();
    const page = await reader.task(id, cursor, signal);
    if (
      page.task.id !== id ||
      page.nextSequence < cursor ||
      (page.hasMore && page.nextSequence <= cursor)
    )
      throw new Error('Invalid history cursor');
    for (const event of page.events) events.set(event.sequence, event);
    cursor = page.nextSequence;
    if (!page.hasMore)
      return {
        ...page,
        events: [...events.values()].sort((a, b) => a.sequence - b.sequence),
      };
  }
}

/** A failed read must never terminate synchronization. One read at a time. */
export function pollWithRecovery(
  read: (signal: AbortSignal) => Promise<number>,
  onError: (error: unknown) => void,
  environment: Pick<Window, 'addEventListener' | 'removeEventListener'>,
): () => void {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  let busy = false;
  let failures = 0;
  const refresh = async () => {
    if (controller.signal.aborted || busy) return;
    clearTimeout(timer);
    busy = true;
    let delay = 3_000;
    try {
      delay = await read(controller.signal);
      failures = 0;
    } catch (error) {
      if (!controller.signal.aborted) onError(error);
      delay = Math.min(30_000, 1_000 * 2 ** Math.min(failures++, 5));
    } finally {
      busy = false;
      if (!controller.signal.aborted)
        timer = setTimeout(() => void refresh(), delay);
    }
  };
  const wake = () => void refresh();
  environment.addEventListener('online', wake);
  environment.addEventListener('focus', wake);
  void refresh();
  return () => {
    controller.abort();
    clearTimeout(timer);
    environment.removeEventListener('online', wake);
    environment.removeEventListener('focus', wake);
  };
}
