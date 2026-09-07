import type { TaskDetail } from './contracts.ts';
export interface ConversationStop {
  id: string;
  title: string;
  preview: string;
  status: string;
  width: number;
}
export function previewText(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/```[^\n]*\n?/g, '')
    .replace(/[`*_#>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
export function conversationStops(
  detail: TaskDetail | undefined,
): ConversationStop[] {
  if (!detail) return [];
  const answers = new Map<string, string[]>(),
    deltas = new Map<string, string[]>();
  for (const event of detail.events) {
    if (!event.turnId) continue;
    const text =
      typeof event.data.text === 'string'
        ? event.data.text
        : typeof event.data.delta === 'string'
          ? event.data.delta
          : '';
    const target =
      event.type === 'agent.message.completed'
        ? answers
        : event.type === 'agent.message.delta'
          ? deltas
          : undefined;
    if (target && text) {
      const parts = target.get(event.turnId) ?? [];
      parts.push(text);
      target.set(event.turnId, parts);
    }
  }
  return detail.turns.map((turn) => {
    const title =
      previewText(turn.prompt) ||
      turn.attachments?.map((a) => a.name).join(', ') ||
      'Attached files';
    const answer =
      answers.get(turn.id)?.join('\n') ||
      deltas.get(turn.id)?.join('') ||
      turn.error ||
      '';
    return {
      id: turn.id,
      title: title.slice(0, 180),
      preview:
        previewText(answer).slice(0, 280) ||
        (turn.status === 'running' || turn.status === 'queued'
          ? 'Working on this message…'
          : 'No response to preview.'),
      status: turn.status,
      width: 10 + Math.min(18, Math.round(title.length / 8)),
    };
  });
}
/** Last exchange whose top has crossed the reading line. */
export function activeStopIndex(
  offsets: readonly number[],
  readingLine: number,
): number {
  if (!offsets.length) return -1;
  let low = 0,
    high = offsets.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (offsets[middle]! <= readingLine) low = middle;
    else high = middle - 1;
  }
  return low;
}

/** Exchanges intersecting the unobscured viewport, including partial visibility. */
export function visibleStopIndices(
  ranges: readonly { top: number; bottom: number }[],
  viewportTop: number,
  viewportBottom: number,
): number[] {
  if (viewportBottom <= viewportTop) return [];
  return ranges.flatMap((range, index) =>
    Number.isFinite(range.top) &&
    Number.isFinite(range.bottom) &&
    range.bottom > range.top &&
    range.bottom > viewportTop &&
    range.top < viewportBottom
      ? [index]
      : [],
  );
}
