import { readFileEdits, type FileEdit } from './activity';
import type { TaskEvent } from './contracts';

export interface TimelineMessage {
  kind: 'message';
  id: string;
  sequence: number;
  text: string;
  completed?: boolean;
}

export interface TimelineReasoning {
  kind: 'reasoning';
  id: string;
  sequence: number;
  sections: readonly string[];
}

export interface TimelineTool {
  kind: 'tool';
  id: string;
  sequence: number;
  toolKind: string;
  title: string;
  detail?: string;
  output?: string;
  status: string;
  durationMs?: number;
  exitCode?: number;
  files: readonly string[];
  edits?: readonly FileEdit[];
}

export type TurnTimelineItem = TimelineMessage | TimelineReasoning | TimelineTool;

const text = (value: unknown) => typeof value === 'string' ? value : '';
const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : undefined;

export function buildTurnTimeline(events: readonly TaskEvent[]): TurnTimelineItem[] {
  const entries = new Map<string, TurnTimelineItem>();

  for (const event of [...events].sort((left, right) => left.sequence - right.sequence)) {
    const itemId = text(event.data.itemId) || `${event.type}:${event.sequence}`;

    if (event.type === 'agent.message.delta' || event.type === 'agent.message.completed') {
      const current = entries.get(itemId);
      const currentText = current?.kind === 'message' ? current.text : '';
      const nextText = event.type === 'agent.message.completed'
        ? text(event.data.text)
        : `${currentText}${text(event.data.text)}`;
      entries.set(itemId, {
        kind: 'message',
        id: itemId,
        sequence: current?.sequence ?? event.sequence,
        text: nextText,
        completed: event.type === 'agent.message.completed',
      });
      continue;
    }

    if (event.type === 'reasoning.summary.delta' || event.type === 'reasoning.summary.completed') {
      const current = entries.get(itemId);
      const sections = current?.kind === 'reasoning' ? [...current.sections] : [];
      if (event.type === 'reasoning.summary.completed') {
        const completed = Array.isArray(event.data.sections)
          ? event.data.sections.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
          : [];
        sections.splice(0, sections.length, ...completed);
      } else {
        const index = number(event.data.summaryIndex) ?? 0;
        sections[index] = `${sections[index] ?? ''}${text(event.data.text)}`;
      }
      entries.set(itemId, {
        kind: 'reasoning',
        id: itemId,
        sequence: current?.sequence ?? event.sequence,
        sections: sections.filter(Boolean),
      });
      continue;
    }

    if (event.type === 'activity.started' || event.type === 'activity.completed') {
      const current = entries.get(itemId);
      const prior = current?.kind === 'tool' ? current : undefined;
      entries.set(itemId, {
        kind: 'tool',
        id: itemId,
        sequence: prior?.sequence ?? event.sequence,
        toolKind: text(event.data.kind) || prior?.toolKind || 'tool',
        title: text(event.data.title) || prior?.title || 'Tool call',
        detail: text(event.data.detail) || prior?.detail,
        output: text(event.data.output) || prior?.output,
        status: ['pending', 'in_progress', 'inProgress'].includes(text(event.data.status))
          ? 'inProgress'
          : text(event.data.status) || (event.type === 'activity.completed' ? 'completed' : 'inProgress'),
        edits: readFileEdits(event.data.edits) ?? prior?.edits,
        durationMs: number(event.data.durationMs) ?? prior?.durationMs,
        exitCode: number(event.data.exitCode) ?? prior?.exitCode,
        files: Array.isArray(event.data.files)
          ? event.data.files.filter((entry): entry is string => typeof entry === 'string')
          : prior?.files ?? [],
      });
    }
  }

  return [...entries.values()]
    .filter((entry) => entry.kind !== 'message' || entry.text.length > 0)
    .filter((entry) => entry.kind !== 'reasoning' || entry.sections.length > 0)
    .sort((left, right) => left.sequence - right.sequence);
}

export function formatWorkDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return remainingSeconds ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}
