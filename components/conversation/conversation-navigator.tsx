'use client';
import { useEffect, useRef, useState } from 'react';
import { List, X } from 'lucide-react';
import {
  visibleStopIndices,
  type ConversationStop,
} from '@/lib/workspace/conversation-navigation';

export function ConversationNavigator({
  stops,
}: {
  stops: readonly ConversationStop[];
}) {
  const root = useRef<HTMLElement>(null);
  const [visible, setVisible] = useState<readonly string[]>([]);
  const active = visible[0] ?? '';
  const [hover, setHover] = useState<{ id: string; top: number }>();
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    const pane = root.current?.closest('.conversation-pane');
    const viewport = pane?.querySelector<HTMLElement>(
      '[data-slot="scroll-area-viewport"]',
    );
    const content = pane?.querySelector<HTMLElement>('.conversation-content');
    if (!viewport || !content) return;
    const composer = pane?.querySelector<HTMLElement>('.composer');
    const composerWrap = pane?.querySelector<HTMLElement>('.composer-wrap');
    let frame = 0;
    function update() {
      frame = 0;
      const bounds = viewport!.getBoundingClientRect();
      const bottom = Math.min(
        bounds.bottom,
        composer?.getBoundingClientRect().top ?? bounds.bottom,
      );
      const ranges = stops.map((stop) => {
        const element = document.getElementById(`exchange-${stop.id}`);
        return (
          element?.getBoundingClientRect() ?? {
            top: Infinity,
            bottom: Infinity,
          }
        );
      });
      const next = visibleStopIndices(ranges, bounds.top, bottom).map(
        (index) => stops[index]!.id,
      );
      setVisible((previous) =>
        previous.length === next.length &&
        previous.every((id, index) => id === next[index])
          ? previous
          : next,
      );
    }
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(content);
    observer.observe(viewport);
    if (composerWrap) observer.observe(composerWrap);
    viewport.addEventListener('scroll', schedule, { passive: true });
    schedule();
    return () => {
      observer.disconnect();
      viewport.removeEventListener('scroll', schedule);
      cancelAnimationFrame(frame);
    };
  }, [stops]);
  if (stops.length < 2) return null;
  function jump(id: string) {
    const viewport = root.current
      ?.closest('.conversation-pane')
      ?.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]');
    const element = document.getElementById(`exchange-${id}`);
    if (!viewport || !element) return;
    viewport.scrollTo({
      top:
        viewport.scrollTop +
        element.getBoundingClientRect().top -
        viewport.getBoundingClientRect().top -
        24,
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches
        ? 'instant'
        : 'smooth',
    });
    setExpanded(false);
  }
  function showPreview(id: string, element: HTMLButtonElement) {
    const bounds = root.current?.getBoundingClientRect();
    if (!bounds) return;
    setHover({
      id,
      top: Math.max(
        0,
        Math.min(
          element.getBoundingClientRect().top - bounds.top - 28,
          bounds.height - 150,
        ),
      ),
    });
  }
  const preview = stops.find((stop) => stop.id === hover?.id);
  return (
    <nav
      className={`conversation-navigator${expanded ? ' is-expanded' : ''}`}
      aria-label="Conversation navigation"
      ref={root}
    >
      <button
        type="button"
        className="conversation-nav-toggle"
        aria-label={
          expanded ? 'Close conversation navigation' : 'Jump to a message'
        }
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        {expanded ? <X size={15} /> : <List size={15} />}
        <span>Jump</span>
      </button>
      <div className="conversation-nav-rail">
        {stops.map((stop, index) => (
          <button
            type="button"
            key={stop.id}
            className={`conversation-nav-marker${visible.includes(stop.id) ? ' is-active' : ''}`}
            aria-label={`Message ${index + 1}: ${stop.title}${visible.includes(stop.id) ? ', currently visible' : ''}`}
            aria-current={active === stop.id ? 'location' : undefined}
            tabIndex={
              active ? (active === stop.id ? 0 : -1) : index === 0 ? 0 : -1
            }
            onMouseEnter={(event) => showPreview(stop.id, event.currentTarget)}
            onMouseLeave={() => setHover(undefined)}
            onFocus={(event) => showPreview(stop.id, event.currentTarget)}
            onBlur={() => setHover(undefined)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                setHover(undefined);
                setExpanded(false);
                return;
              }
              if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key))
                return;
              event.preventDefault();
              const next =
                event.key === 'Home'
                  ? 0
                  : event.key === 'End'
                    ? stops.length - 1
                    : (index +
                        (event.key === 'ArrowDown' ? 1 : -1) +
                        stops.length) %
                      stops.length;
              root.current
                ?.querySelectorAll<HTMLButtonElement>(
                  '.conversation-nav-marker',
                )
                [next]?.focus();
            }}
            onClick={() => jump(stop.id)}
          >
            <i style={{ width: stop.width }} aria-hidden="true" />
            <span className="conversation-nav-mobile-title">{stop.title}</span>
          </button>
        ))}
      </div>
      {preview && (
        <div className="conversation-nav-preview" style={{ top: hover!.top }}>
          <span className="conversation-nav-preview-label">
            Message {stops.findIndex((s) => s.id === preview.id) + 1} of{' '}
            {stops.length}
            {preview.status === 'running' && ' · Working'}
          </span>
          <strong>{preview.title}</strong>
          <p>{preview.preview}</p>
        </div>
      )}
    </nav>
  );
}
