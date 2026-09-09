'use client';

import { useId, useRef, useState } from 'react';
import {
  Check,
  ChevronRight,
  FilePenLine,
  LoaderCircle,
  ShieldCheck,
  Terminal,
  X,
} from 'lucide-react';
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
  const command = value('command');
  const path = value('path') || value('grantRoot');
  const action = command || path;
  const reason = value('reason');
  const tool = value('toolName');
  const supported = Array.isArray(approval.details.supportedDecisions)
    ? approval.details.supportedDecisions
    : undefined;
  const canAccept = !supported || supported.includes('accept');
  const canDecline = !supported || supported.includes('decline');
  const canCancel = supported?.includes('cancel');
  const Icon = approval.kind === 'fileChange' ? FilePenLine : Terminal;

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
      <header className="approval-heading">
        <span className="approval-icon">
          <ShieldCheck aria-hidden="true" />
        </span>
        <div>
          <h3 id={titleId}>Permission needed</h3>
          <p>The agent is waiting for your decision.</p>
        </div>
        <span className="approval-badge">
          {pending ? 'Sending' : 'Your turn'}
        </span>
      </header>
      <div className="approval-request">
        <div className="approval-action-label">
          <Icon aria-hidden="true" />
          <span>
            {tool ||
              (approval.kind === 'fileChange' ? 'File access' : 'Run command')}
          </span>
        </div>
        {action ? (
          <pre className="approval-command">{action}</pre>
        ) : (
          <p className="approval-description">{approval.summary}</p>
        )}
        {value('cwd') && (
          <div className="approval-location">
            <span>In</span>
            <code>{value('cwd')}</code>
          </div>
        )}
        {reason && reason !== action && (
          <p className="approval-description">{reason}</p>
        )}
        {action &&
          approval.summary !== action &&
          approval.summary !== reason &&
          (tool ? (
            <details className="approval-context">
              <summary>
                <ChevronRight aria-hidden="true" />
                Request details
              </summary>
              <pre>{approval.summary}</pre>
            </details>
          ) : (
            <p className="approval-description">{approval.summary}</p>
          ))}
      </div>
      {error && (
        <p className="approval-error" role="alert">
          {error}
        </p>
      )}
      <footer className="approval-footer">
        <output className="approval-scope">
          {pending ? 'Sending your decision…' : 'Applies to this request only'}
        </output>
        <div className="approval-actions">
          {(canDecline || canCancel) && (
            <Button
              className="approval-decline"
              variant="ghost"
              disabled={pending !== null}
              onClick={() => void decide(canDecline ? 'decline' : 'cancel')}
            >
              <X />
              {canDecline ? 'Decline' : 'Cancel'}
            </Button>
          )}
          {canAccept && (
            <Button
              className="approval-accept"
              disabled={pending !== null}
              onClick={() => void decide('accept')}
            >
              {pending === 'accept' ? (
                <LoaderCircle className="tool-spinner" />
              ) : (
                <Check />
              )}
              Allow once
            </Button>
          )}
        </div>
      </footer>
    </section>
  );
}
