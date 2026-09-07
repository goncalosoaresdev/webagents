'use client';
import { useEffect, useState } from 'react';
import { RefreshCw, Clock3, Gauge } from 'lucide-react';
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
  PopoverTitle,
} from '@/components/ui/popover';
import {
  resetLabel,
  tightestRemaining,
  type ProviderLimits,
} from '@/lib/providers/limits';
import type { WebcodeApi } from '@/lib/api/client';

export function UsageLimits({
  api,
  providerId,
}: {
  api: WebcodeApi;
  providerId: string;
}) {
  const [limits, setLimits] = useState<ProviderLimits>();
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState(0);
  const [now, setNow] = useState(0);
  useEffect(() => {
    let disposed = false,
      running = false;
    async function load(force = false) {
      if (running || document.hidden) return;
      running = true;
      setBusy(true);
      try {
        const value = await api.limits(providerId, force);
        if (!disposed) {
          setLimits(value);
          setNow(Date.now());
        }
      } catch {
        if (!disposed)
          setLimits({
            providerId,
            windows: [],
            status: 'unavailable',
            checkedAt: new Date().toISOString(),
          });
      } finally {
        running = false;
        if (!disposed) setBusy(false);
      }
    }
    void load(version > 0);
    const refresh = () => void load();
    const timer = setInterval(() => {
      if (!document.hidden) {
        setNow(Date.now());
        void load();
      }
    }, 60000);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      disposed = true;
      clearInterval(timer);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [api, providerId, version]);
  const current = limits?.providerId === providerId ? limits : undefined;
  const remaining = tightestRemaining(current, now);
  const low = remaining !== null && remaining <= 20;
  return (
    <Popover>
      <PopoverTrigger
        className={`usage-trigger${low ? ' is-low' : ''}`}
        aria-label={
          remaining === null
            ? 'View usage limits'
            : `Usage limits: lowest allowance ${Math.floor(remaining)} percent remaining`
        }
        title="Usage limits"
      >
        <span className="usage-bar" aria-hidden="true">
          <i style={{ width: `${remaining ?? 0}%` }} />
        </span>
        <span>{low ? `${Math.floor(remaining!)}% left` : 'Limits'}</span>
      </PopoverTrigger>
      <PopoverContent
        className="usage-panel"
        side="top"
        align="end"
        sideOffset={12}
      >
        <div className="usage-heading">
          <div>
            <PopoverTitle>Usage limits</PopoverTitle>
            <p>
              {providerId === 'codex'
                ? 'Codex'
                : providerId === 'muse'
                  ? 'Muse'
                  : providerId}{' '}
              · Account allowance
            </p>
          </div>
          <button
            type="button"
            disabled={busy}
            aria-label="Refresh usage limits"
            onClick={() => setVersion((value) => value + 1)}
          >
            <RefreshCw size={15} className={busy ? 'attachment-spin' : ''} />
          </button>
        </div>
        {current?.accountLabel && (
          <p className="usage-account" title={current.accountLabel}>
            {current.accountLabel}
          </p>
        )}
        {current?.windows.length ? (
          <div className="usage-windows">
            {current.windows.map((window) => {
              const expired =
                window.resetsAt !== null && window.resetsAt * 1000 <= now;
              const amount =
                expired || now - Date.parse(current.checkedAt) > 120000
                  ? null
                  : window.remainingPercent;
              return (
                <div
                  className={`usage-window${amount !== null && amount <= 20 ? ' is-low' : ''}`}
                  key={window.id}
                >
                  <div>
                    <strong>{window.label}</strong>
                    <span>
                      {amount === null ? (
                        'Unavailable'
                      ) : (
                        <>
                          <b>{Math.floor(amount)}%</b> remaining
                        </>
                      )}
                    </span>
                  </div>
                  <progress
                    max={100}
                    value={amount ?? 0}
                    aria-label={`${window.label}: ${amount === null ? 'unavailable' : `${amount}% remaining`}`}
                  />
                  <p>
                    <Clock3 size={11} />
                    <span
                      title={
                        window.resetsAt
                          ? new Date(window.resetsAt * 1000).toLocaleString()
                          : undefined
                      }
                    >
                      {resetLabel(window.resetsAt, now)}
                    </span>
                  </p>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="usage-empty">
            <Gauge size={24} />
            <strong>
              {busy ? 'Checking your allowance…' : 'Limits unavailable'}
            </strong>
            <p>
              {busy
                ? 'Fetching the latest provider information.'
                : 'This account or provider isn’t reporting usage limits right now.'}
            </p>
          </div>
        )}
        <div className="usage-footnote">
          <span>
            {current
              ? `Updated ${new Date(current.checkedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
              : 'Waiting for provider'}
          </span>
          <span>Shared across account</span>
        </div>
      </PopoverContent>
    </Popover>
  );
}
