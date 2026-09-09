'use client';
import type { TaskEvent } from '@/lib/workspace/contracts';
import { threadContext } from '@/lib/providers/context';
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
  PopoverTitle,
} from '@/components/ui/popover';

export function ContextWindow({
  events,
  providerId,
}: {
  events: readonly TaskEvent[];
  providerId: string;
}) {
  const context = threadContext(events, providerId);
  const percent = context?.percent;
  return (
    <Popover>
      <PopoverTrigger
        className={`usage-trigger${percent != null && percent >= 80 ? ' is-low' : ''}`}
        aria-label={
          percent == null
            ? 'Thread context usage unavailable'
            : `Thread context: ${Math.round(percent)}% used`
        }
      >
        <span className="usage-bar" aria-hidden="true">
          <i style={{ width: `${percent ?? 0}%` }} />
        </span>
        <span>
          {percent == null ? 'Context' : `${Math.round(percent)}% context`}
        </span>
      </PopoverTrigger>
      <PopoverContent
        className="usage-panel"
        side="top"
        align="end"
        sideOffset={12}
      >
        <div className="usage-heading">
          <div>
            <PopoverTitle>Context window</PopoverTitle>
            <p>Current thread · {providerId}</p>
          </div>
        </div>
        {context ? (
          <div className="usage-windows">
            <div className="usage-window">
              <div>
                <strong>{context.used.toLocaleString()} tokens used</strong>
                <span>
                  {percent == null
                    ? 'Capacity unknown'
                    : `${Math.round(percent)}% used`}
                </span>
              </div>
              {context.window !== null && (
                <progress
                  max={context.window}
                  value={Math.min(context.used, context.window)}
                  aria-label="Thread context used"
                />
              )}
              <p>
                {context.window === null
                  ? 'The provider has not reported a context limit.'
                  : `${context.window.toLocaleString()} token capacity · ${Math.max(0, context.window - context.used).toLocaleString()} remaining`}
              </p>
            </div>
          </div>
        ) : (
          <div className="usage-empty">
            <strong>Context usage unavailable</strong>
            <p>
              Usage appears when this provider reports context for the thread.
            </p>
          </div>
        )}
        <div className="usage-footnote">
          Latest provider report. Usage can decrease after compaction.
        </div>
      </PopoverContent>
    </Popover>
  );
}
