import type { TaskEvent } from '../workspace/contracts.ts';

export function threadContext(
  events: readonly TaskEvent[],
  providerId: string,
) {
  const event = events.findLast(
    (event) =>
      event.type === 'context.updated' &&
      event.data.providerId === providerId &&
      !event.data.executionId,
  );
  const used = event?.data.usedTokens;
  const capacity = event?.data.windowTokens;
  if (typeof used !== 'number' || !Number.isFinite(used) || used < 0)
    return null;
  const window =
    typeof capacity === 'number' && Number.isFinite(capacity) && capacity > 0
      ? capacity
      : null;
  return {
    used,
    window,
    percent: window === null ? null : Math.min(100, (used / window) * 100),
  };
}
