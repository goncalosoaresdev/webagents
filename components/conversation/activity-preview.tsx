'use client';

import { Check, Circle, FilePenLine, LoaderCircle } from 'lucide-react';
import type { TimelineTool } from '@/lib/workspace/timeline';
import type { FileEdit } from '@/lib/workspace/activity';

function DiffLines({ lines }: { lines: readonly string[] }) {
  return (
    <pre className="activity-diff">
      {lines.map((line, index) => (
        <span
          key={index}
          className={
            line.startsWith('+')
              ? 'diff-added'
              : line.startsWith('-')
                ? 'diff-removed'
                : 'diff-context'
          }
        >
          {line || ' '}
        </span>
      ))}
    </pre>
  );
}

export function FileEditPreview({ edit }: { edit: FileEdit }) {
  const lines = edit.diff
    .split('\n')
    .filter((line) => !/^(?:diff --git |index |--- |\+\+\+ )/.test(line));
  const added = lines.filter((line) => line.startsWith('+')).length;
  const removed = lines.filter((line) => line.startsWith('-')).length;
  const firstChange = lines.findIndex((line) => /^[+-]/.test(line));
  const start = Math.max(0, firstChange - 2);
  const preview = lines.slice(start, start + 12);
  return (
    <section className="activity-file" aria-label={`Changes to ${edit.path}`}>
      <header>
        <FilePenLine aria-hidden="true" />
        <strong>{edit.path}</strong>
        <span
          className="diff-counts"
          aria-label={`${added} added, ${removed} removed${edit.truncated ? ', partial diff' : ''}`}
        >
          <span className="diff-added-count">
            +{added}
            {edit.truncated ? '…' : ''}
          </span>
          <span className="diff-removed-count">
            −{removed}
            {edit.truncated ? '…' : ''}
          </span>
        </span>
      </header>
      {edit.diff ? (
        <DiffLines lines={preview} />
      ) : (
        <p className="activity-note">No line preview provided.</p>
      )}
      {(start > 0 || lines.length > start + 12) && (
        <details className="activity-more">
          <summary>View available diff · {lines.length} lines</summary>
          <DiffLines lines={lines} />
        </details>
      )}
      {edit.truncated && (
        <p className="activity-note">Partial preview · large diff truncated</p>
      )}
    </section>
  );
}

function activityLabel(tool: TimelineTool) {
  if (tool.edits?.length) return 'File changes';
  if (
    tool.toolKind === 'fileChange' ||
    /^(edit|write|delete|move)$/i.test(tool.toolKind)
  )
    return 'Editing files';
  if (tool.toolKind === 'webSearch') return 'Searching the web';
  if (
    /^(read|read_file|readfile)$/i.test(tool.title) ||
    tool.toolKind === 'read'
  )
    return 'Reading files';
  if (/^(search|grep|glob)$/i.test(tool.title) || tool.toolKind === 'search')
    return 'Searching';
  if (
    tool.toolKind === 'commandExecution' ||
    tool.toolKind === 'execute' ||
    tool.toolKind === 'userShell'
  )
    return 'Running command';
  return tool.title;
}

export function ActivityPreview({ tool }: { tool: TimelineTool }) {
  const failed =
    ['failed', 'rejected', 'timedOut', 'cancelled'].includes(tool.status) ||
    (tool.exitCode !== undefined && tool.exitCode !== 0);
  const running = tool.status === 'inProgress';
  const label = activityLabel(tool);
  const detail =
    tool.toolKind === 'commandExecution' ? tool.title : tool.detail;
  const paths = tool.files.filter(
    (path) => !tool.edits?.some((edit) => edit.path === path),
  );
  return (
    <div className="live-activity-item">
      <span className="tool-call-state">
        {failed ? (
          <Circle />
        ) : running ? (
          <LoaderCircle className="tool-spinner" />
        ) : (
          <Check />
        )}
      </span>
      <div className="activity-content">
        <div className="activity-heading">
          <strong>{label}</strong>
          <span className="live-activity-status">
            {failed ? 'Not completed' : running ? 'In progress' : 'Completed'}
          </span>
        </div>
        {!tool.edits?.length && detail && detail !== label && <p>{detail}</p>}
        {paths.length > 0 && <p>{paths.join(', ')}</p>}
        {tool.edits?.map((edit, index) => (
          <FileEditPreview key={`${edit.path}:${index}`} edit={edit} />
        ))}
        {!tool.edits?.length &&
          tool.output &&
          !/^\s*[[{]/.test(tool.output) && (
            <pre className="activity-output">
              {tool.output.slice(-600).split('\n').slice(-4).join('\n')}
            </pre>
          )}
      </div>
    </div>
  );
}
