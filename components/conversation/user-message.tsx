'use client';

import { useEffect, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { SentAttachments } from '@/components/conversation/attachment-picker';
import type { Attachment } from '@/lib/workspace/contracts';
import type { WebcodeApi } from '@/lib/api/client';

function messageTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function UserMessage({
  text,
  sentAt,
  attachments,
  api,
}: {
  text: string;
  sentAt: string;
  attachments?: readonly Attachment[];
  api: WebcodeApi;
}) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1_600);
    return () => clearTimeout(timer);
  }, [copied]);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }
  const time = messageTime(sentAt);
  return (
    <div className="user-message-wrap">
      <div className="user-message">
        {text}
        <SentAttachments attachments={attachments} api={api} />
      </div>
      <div className="user-message-meta">
        {time && (
          <time dateTime={sentAt} title={new Date(sentAt).toLocaleString()}>
            {time}
          </time>
        )}
        <button
          type="button"
          className="user-message-copy"
          aria-label={copied ? 'Message copied' : 'Copy message'}
          title={copied ? 'Copied' : 'Copy message'}
          onClick={() => void copy()}
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
        </button>
      </div>
    </div>
  );
}
