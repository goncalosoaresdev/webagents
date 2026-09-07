'use client';

/* oxlint-disable jsx-a11y/no-noninteractive-tabindex -- Scrollable code and tables need keyboard focus for horizontal scrolling. */

import {
  isValidElement,
  memo,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Check, Copy } from 'lucide-react';
import { Button } from '../ui/button';

function CodeBlock({ children }: { children?: ReactNode }) {
  const content = useRef<HTMLPreElement>(null);
  const [status, setStatus] = useState<'idle' | 'copied' | 'failed'>('idle');
  const language = isValidElement<{ className?: string }>(children)
    ? /language-([\w+-]+)/.exec(children.props.className ?? '')?.[1]
    : undefined;
  useEffect(() => {
    if (status === 'idle') return;
    const timer = setTimeout(() => setStatus('idle'), 2_500);
    return () => clearTimeout(timer);
  }, [status]);
  async function copy() {
    try {
      await navigator.clipboard.writeText(content.current?.textContent ?? '');
      setStatus('copied');
    } catch {
      setStatus('failed');
    }
  }
  return (
    <div className="response-code">
      <div className="response-code-header">
        <span>{language ?? 'Code'}</span>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void copy()}
          aria-label="Copy code"
        >
          {status === 'copied' ? <Check /> : <Copy />}
          <span>
            {status === 'copied'
              ? 'Copied'
              : status === 'failed'
                ? 'Try again'
                : 'Copy'}
          </span>
        </Button>
      </div>
      <pre
        ref={content}
        tabIndex={0}
        aria-label={language ? `${language} code` : 'Code block'}
      >
        {children}
      </pre>
      <span className="sr-only" aria-live="polite">
        {status === 'copied'
          ? 'Code copied to clipboard.'
          : status === 'failed'
            ? 'Could not copy code. You can select and copy it manually.'
            : ''}
      </span>
    </div>
  );
}

/** Parse Markdown as React elements; provider output never becomes raw HTML. */
export const ResponseMarkdown = memo(function ResponseMarkdown({
  text,
}: {
  text: string;
}) {
  return (
    <div className="response-prose">
      <Markdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={{
          pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
          table: ({ children }) => (
            <section
              className="response-table"
              tabIndex={0}
              aria-label="Response table"
            >
              <table>{children}</table>
            </section>
          ),
          a: ({ children, href }) =>
            href ? (
              <a href={href} target="_blank" rel="noopener noreferrer">
                {children}
              </a>
            ) : (
              <span>{children}</span>
            ),
          img: ({ alt, src }) =>
            typeof src === 'string' ? (
              <a href={src} target="_blank" rel="noopener noreferrer">
                {alt || 'View image'}
              </a>
            ) : (
              <span>{alt}</span>
            ),
        }}
      >
        {text}
      </Markdown>
    </div>
  );
});
