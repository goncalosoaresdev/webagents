'use client';

import { useId, useRef, useState } from 'react';
import { LoaderCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type {
  ApprovalDecision,
  ApprovalRequest,
} from '@/lib/workspace/contracts';

export interface ApprovalCardProps {
  approval: ApprovalRequest;
  onDecision: (id: string, decision: ApprovalDecision) => void | Promise<void>;
}

export function ApprovalCard({ approval, onDecision }: ApprovalCardProps) {
  const titleId = useId();
  const [pending, setPending] = useState<ApprovalDecision | null>(null);
  const [error, setError] = useState('');
  const submitting = useRef(false);
  const value = (key: string) =>
    typeof approval.details[key] === 'string'
      ? String(approval.details[key])
      : '';
  // Muse may supply tool arguments in its summary rather than structured details.
  let args: Record<string, unknown> = {};
  const jsonStart = approval.summary.indexOf('{');
  if (jsonStart >= 0) {
    try {
      const parsed: unknown = JSON.parse(approval.summary.slice(jsonStart));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
        args = parsed as Record<string, unknown>;
    } catch {
      /* Keep the original summary visible if arguments are incomplete. */
    }
  }
  const argument = (key: string) =>
    typeof args[key] === 'string' ? String(args[key]) : '';
  const command = value('command') || argument('command');
  const path = value('path') || value('grantRoot') || argument('path');
  const action = command || path;
  const reason =
    value('reason') ||
    argument('description') ||
    (Object.keys(args).length ? '' : approval.summary);
  const directory = value('cwd') || argument('cwd');
  const supported = Array.isArray(approval.details.supportedDecisions)
    ? approval.details.supportedDecisions
    : undefined;
  const canAccept = !supported || supported.includes('accept');
  const canDecline = !supported || supported.includes('decline');
  const canCancel = supported?.includes('cancel');

  async function decide(decision: ApprovalDecision) {
    if (submitting.current) return;
    submitting.current = true;
    setPending(decision);
    setError('');
    try {
      await onDecision(approval.id, decision);
      // Keep controls locked until the resolved request disappears from the feed.
    } catch (cause) {
      submitting.current = false;
      setPending(null);
      setError(
        cause instanceof Error
          ? cause.message
          : 'Could not send your decision. Try again.',
      );
    }
  }

  return (
    <section
      className="approval-card"
      aria-labelledby={titleId}
      aria-busy={pending !== null}
    >
      <h3 id={titleId}>
        {approval.kind === 'fileChange'
          ? 'Allow file access?'
          : 'Allow this action?'}
      </h3>
      {reason && reason !== action && (
        <p className="approval-description">{reason}</p>
      )}
      {action ? (
        <pre className="approval-command">{action}</pre>
      ) : (
        !reason && <p className="approval-description">{approval.summary}</p>
      )}
      {directory && <code className="approval-location">{directory}</code>}
      {error && (
        <p className="approval-error" role="alert">
          {error}
        </p>
      )}
      <footer className="approval-footer">
        <output className="approval-status">{pending ? 'Sending…' : ''}</output>
        <div className="approval-actions">
          {(canDecline || canCancel) && (
            <Button
              className="approval-decline"
              variant="ghost"
              disabled={pending !== null}
              onClick={() => void decide(canDecline ? 'decline' : 'cancel')}
            >
              {canDecline ? 'Decline' : 'Cancel'}
            </Button>
          )}
          {canAccept && (
            <Button
              className="approval-accept"
              disabled={pending !== null}
              onClick={() => void decide('accept')}
            >
              {pending === 'accept' && (
                <LoaderCircle className="tool-spinner" />
              )}
              Allow once
            </Button>
          )}
        </div>
      </footer>
    </section>
  );
}
