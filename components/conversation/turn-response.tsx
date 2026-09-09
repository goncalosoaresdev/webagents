'use client';

import { ActivityPreview, FileEditPreview } from './activity-preview';

import { modelDisplayName, providerDisplayName } from '@/lib/providers/display';

import { useEffect, useMemo, useState } from 'react';
import {
  Check,
  ChevronRight,
  Circle,
  LoaderCircle,
  Terminal,
} from 'lucide-react';
import { ResponseMarkdown } from './response-markdown';
import { ApprovalCard } from './approval-card';
import {
  buildTurnTimeline,
  formatWorkDuration,
  type TimelineTool,
  type TurnTimelineItem,
} from '@/lib/workspace/timeline';
import type {
  ApprovalDecision,
  ApprovalRequest,
  TaskEvent,
  Turn,
} from '@/lib/workspace/contracts';

interface TurnResponseProps {
  turn: Turn;
  events: readonly TaskEvent[];
  approvals: readonly ApprovalRequest[];
  onDecision: (approvalId: string, decision: ApprovalDecision) => void | Promise<void>;
}

type RenderItem =
  | TurnTimelineItem
  | {
      kind: 'tool-group';
      id: string;
      sequence: number;
      tools: readonly TimelineTool[];
    };

function groupTools(items: readonly TurnTimelineItem[]): RenderItem[] {
  const grouped: RenderItem[] = [];
  for (const item of items) {
    const previous = grouped.at(-1);
    if (item.kind === 'tool' && previous?.kind === 'tool-group') {
      grouped[grouped.length - 1] = {
        ...previous,
        tools: [...previous.tools, item],
      };
    } else if (item.kind === 'tool') {
      grouped.push({
        kind: 'tool-group',
        id: `tools:${item.id}`,
        sequence: item.sequence,
        tools: [item],
      });
    } else {
      grouped.push(item);
    }
  }
  return grouped;
}

function toolGroupLabel(tools: readonly TimelineTool[]) {
  const running = tools.some((tool) => tool.status === 'inProgress');
  const failed = tools.filter((tool) => tool.status === 'failed' || (tool.exitCode !== undefined && tool.exitCode !== 0)).length;
  const commands = tools.every((tool) => tool.toolKind === 'commandExecution');
  const changes = tools.every((tool) => tool.toolKind === 'fileChange');
  const verb = running ? 'Running' : commands ? 'Ran' : changes ? 'Updated' : 'Used';
  const noun = commands ? 'command' : changes ? 'file operation' : 'tool';
  return `${verb} ${tools.length} ${noun}${tools.length === 1 ? '' : 's'}${failed ? ` · ${failed} failed` : ''}`;
}

function ToolGroup({ tools, live = false }: { tools: readonly TimelineTool[]; live?: boolean }) {
  const running = tools.some((tool) => tool.status === 'inProgress');
  const failed = tools.some(
    (tool) =>
      tool.status === 'failed' ||
      (tool.exitCode !== undefined && tool.exitCode !== 0),
  );
  if (live) return (
    <section className="live-activity" aria-label="Live tool activity">
      <div className="live-activity-heading">{toolGroupLabel(tools)}</div>
      {tools.map((tool) => <ActivityPreview key={tool.id} tool={tool} />)}
      <ToolGroup tools={tools} />
    </section>
  );
  return (
    <details
      className={`tool-group${running ? ' is-running' : ''}${failed ? ' is-failed' : ''}`}
    >
      <summary>
        <ChevronRight />
        <Terminal />
        <span>{toolGroupLabel(tools)}</span>
        {running && <LoaderCircle className="tool-spinner" />}
      </summary>
      <div className="tool-group-details">
        {tools.map((tool) => (
          <div className="tool-call" key={tool.id}>
            <span className="tool-call-state">
              {tool.status === 'inProgress' ? (
                <LoaderCircle className="tool-spinner" />
              ) : tool.status === 'failed' ||
                (tool.exitCode !== undefined && tool.exitCode !== 0) ? (
                <Circle />
              ) : (
                <Check />
              )}
            </span>
            <div>
              <strong>{tool.title}</strong>
              {tool.detail && <small>{tool.detail}</small>}
              {tool.files.length > 0 && <small>{tool.files.join(', ')}</small>}
              {tool.edits?.map((edit, index) => <FileEditPreview key={`${edit.path}:${index}`} edit={edit} />)}
              {tool.output && <pre>{tool.output}</pre>}
            </div>
            {tool.durationMs !== undefined && (
              <time>{formatWorkDuration(tool.durationMs)}</time>
            )}
          </div>
        ))}
      </div>
    </details>
  );
}

function TimelineItems({ items, live = false }: { items: readonly TurnTimelineItem[]; live?: boolean }) {
  return (
    <>
      {groupTools(items).map((item) => {
        if (item.kind === 'message')
          return <ResponseMarkdown key={item.id} text={item.text} streaming={live && !item.completed} />;
        if (item.kind === 'reasoning')
          return (
            <details className="reasoning-summary" key={item.id} open>
              <summary>
                <ChevronRight />
                <span>Reasoning</span>
              </summary>
              <div>
                {item.sections.map((section, index) => (
                  <ResponseMarkdown
                    key={`${item.id}:${index}`}
                    text={section}
                    streaming={live}
                  />
                ))}
              </div>
            </details>
          );
        if (item.kind === 'tool-group')
          return <ToolGroup key={item.id} tools={item.tools} live={live} />;
        return null;
      })}
    </>
  );
}

function useTurnClock(turn: Turn) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    if (turn.status !== 'running') return;
    const update = () => setNow(Date.now());
    update();
    const timer = window.setInterval(update, 1_000);
    return () => window.clearInterval(timer);
  }, [turn.status]);
  const start = Date.parse(turn.createdAt);
  const end = turn.completedAt ? Date.parse(turn.completedAt) : (now ?? start);
  return Number.isFinite(start) && Number.isFinite(end)
    ? Math.max(0, end - start)
    : 0;
}

export function TurnResponse({
  turn,
  events,
  approvals,
  onDecision,
}: TurnResponseProps) {
  const timeline = useMemo(() => buildTurnTimeline(events), [events]);
  const duration = useTurnClock(turn);
  const warnings = events.filter((event) => event.type === 'runtime.warning' && typeof event.data.message === 'string');
  const terminalMessage = [...timeline]
    .reverse()
    .find((item) => item.kind === 'message');
  const foldedItems = terminalMessage
    ? timeline.filter((item) => item.id !== terminalMessage.id)
    : [];
  const settled = turn.status !== 'running' && turn.status !== 'queued';
  const canFold = settled && Boolean(terminalMessage) && foldedItems.length > 0;
  const visibleItems =
    canFold && terminalMessage ? [terminalMessage] : timeline;
  const hasResponse = timeline.length > 0 || warnings.length > 0 || approvals.length > 0 || !settled;

  if (turn.orchestration)
    return (
      <article className="orchestration-response" aria-label="Orchestration">
        <strong>
          {modelDisplayName({ id: turn.model ?? 'Lead', label: '' })} →{' '}
          {modelDisplayName({ id: turn.orchestration.worker.model, label: '' })}
        </strong>
        {(['plan', 'work', 'review'] as const).map((phase) => {
          const execution = turn.executions?.find(
            (entry) => entry.phase === phase,
          );
          const title =
            phase === 'plan'
              ? 'Lead assignment'
              : phase === 'work'
                ? `${providerDisplayName(turn.orchestration!.worker.providerId)} implementation`
                : 'Lead review';
          const status = execution?.status ?? (settled ? 'Not run' : 'Waiting');
          return (
            <section
              key={phase}
              className="orchestration-phase"
              data-status={status}
            >
              <div className="orchestration-phase-heading">
                <span>{title}</span>
                <output>{status}</output>
              </div>
              {execution && (
                <details
                  open={phase === 'review' || execution.status === 'running'}
                >
                  <summary>
                    {modelDisplayName({ id: execution.model, label: '' })} ·
                    View activity
                  </summary>
                  {execution.error && (
                    <p className="attachment-warning">{execution.error}</p>
                  )}
                  <TurnResponse
                    turn={{
                      ...turn,
                      orchestration: undefined,
                      executions: undefined,
                      status: execution.status,
                      createdAt: execution.createdAt,
                      completedAt: execution.completedAt,
                    }}
                    events={events.filter(
                      (event) => event.data.executionId === execution.id,
                    )}
                    approvals={approvals.filter(
                      (approval) => approval.executionId === execution.id,
                    )}
                    onDecision={onDecision}
                  />
                </details>
              )}
            </section>
          );
        })}
      </article>
    );
  if (!hasResponse) return null;

  return (
    <article className="agent-response">
      <div className="agent-body">
        {warnings.map((event) => (
          <output className="attachment-warning" key={event.sequence}>{String(event.data.message)}</output>
        ))}
        {!settled && (
          <div className="working-duration">
            <LoaderCircle className="tool-spinner" />
            <span>Working for {formatWorkDuration(duration)}</span>
          </div>
        )}
        {canFold && (
          <details className="turn-work-fold">
            <summary>
              <span>
                {turn.status === 'interrupted' ? 'Stopped after' : 'Worked for'}{' '}
                {formatWorkDuration(duration)}
              </span>
              <ChevronRight />
            </summary>
            <div className="turn-work-fold-content">
              <TimelineItems items={foldedItems} />
            </div>
          </details>
        )}
        {settled && !canFold && (
          <div className="turn-work-duration">
            <span>
              {turn.status === 'interrupted' ? 'Stopped after' : 'Worked for'}{' '}
              {formatWorkDuration(duration)}
            </span>
          </div>
        )}
        <TimelineItems items={visibleItems} live={!settled} />
        {!settled && timeline.length === 0 && (
          <p className="agent-note">Starting…</p>
        )}
        {approvals.map((approval) => (
          <ApprovalCard key={approval.id} approval={approval} onDecision={onDecision} />
        ))}
      </div>
    </article>
  );
}
