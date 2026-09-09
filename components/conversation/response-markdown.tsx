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
import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Check, Copy } from 'lucide-react';
import { advanceText, revealBudget } from '../../lib/workspace/streaming-text';
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

/** Animate the presentation only; persisted provider text stays exact. */
function useStreamingText(text: string, streaming: boolean) {
  const [visible, setVisible] = useState(() => (streaming ? '' : text));
  const state = useRef({
    target: text,
    visible: streaming ? '' : text,
    budget: 0,
    frame: 0,
    last: 0,
  });
  useEffect(() => {
    const current = state.current;
    current.target = text;
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const flush = () => {
      cancelAnimationFrame(current.frame);
      current.frame = 0;
      current.budget = 0;
      current.visible = current.target;
      setVisible(current.visible);
    };
    const tick = (now: number) => {
      const pending = current.target.length - current.visible.length;
      current.budget += revealBudget(pending, now - current.last);
      current.last = now;
      if (current.budget >= 1) {
        const end = advanceText(
          current.target,
          current.visible.length,
          Math.floor(current.budget),
        );
        current.budget = Math.max(
          0,
          current.budget - (end - current.visible.length),
        );
        current.visible = current.target.slice(0, end);
        setVisible(current.visible);
      }
      current.frame =
        current.visible === current.target ? 0 : requestAnimationFrame(tick);
      if (!current.frame) current.budget = 0;
    };
    if (!streaming || motion.matches || !text.startsWith(current.visible))
      flush();
    else if (!current.frame && current.visible !== text) {
      current.last = performance.now();
      current.frame = requestAnimationFrame(tick);
    }
    const onMotionChange = () => {
      if (motion.matches) flush();
    };
    motion.addEventListener('change', onMotionChange);
    return () => motion.removeEventListener('change', onMotionChange);
  }, [text, streaming]);
  useEffect(
    () => () => {
      cancelAnimationFrame(state.current.frame);
      state.current.frame = 0;
    },
    [],
  );
  return !streaming || !text.startsWith(visible) ? text : visible;
}

const markdownPlugins = [remarkGfm];
const markdownComponents: Components = {
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
};

/** Parse Markdown as React elements; provider output never becomes raw HTML. */
export const ResponseMarkdown = memo(function ResponseMarkdown({
  text,
  streaming = false,
}: {
  text: string;
  streaming?: boolean;
}) {
  const displayedText = useStreamingText(text, streaming);
  return <MarkdownBody text={displayedText} />;
});

const MarkdownBody = memo(function MarkdownBody({ text }: { text: string }) {
  return (
    <div className="response-prose">
      <Markdown
        remarkPlugins={markdownPlugins}
        skipHtml
        components={markdownComponents}
      >
        {text}
      </Markdown>
    </div>
  );
});
