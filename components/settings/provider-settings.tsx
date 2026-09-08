'use client';
import { useEffect, useState } from 'react';
import { ArrowUpRight, Loader2, RefreshCw } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { SpeechSettings } from './speech-settings';
import { ProviderLogo } from '@/components/provider-logo';
import type { WebcodeApi } from '@/lib/api/client';
import type { ProviderInstallation } from '@/lib/providers/installation';

function healthLabel(health: ProviderInstallation['snapshot']['health']) {
  if (health === 'ready') return 'Connected';
  if (health === 'unauthenticated') return 'Sign-in required';
  if (health === 'checking') return 'Checking';
  return 'Unavailable';
}

export function ProviderSettings({
  api,
  open,
  onOpenChange,
}: {
  api: WebcodeApi;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [items, setItems] = useState<ProviderInstallation[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    async function load() {
      try {
        const next = await api.installations();
        if (!cancelled) {
          setItems(next);
          setError('');
        }
      } catch (cause) {
        if (!cancelled)
          setError(
            cause instanceof Error
              ? cause.message
              : 'Unable to load providers.',
          );
      }
      if (!cancelled) timer = setTimeout(() => void load(), 3000);
    }
    void load();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [api, open]);
  async function action(item: ProviderInstallation, update: boolean) {
    setBusy(item.providerId);
    setError('');
    try {
      const next = await (update
        ? api.updateInstallation(item.providerId)
        : api.checkInstallation(item.providerId));
      setItems((current) =>
        current.map((value) =>
          value.providerId === next.providerId ? next : value,
        ),
      );
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Unable to complete this action.',
      );
    } finally {
      setBusy('');
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="provider-settings">
        <header className="settings-header">
          <DialogTitle>Providers</DialogTitle>
          <DialogDescription>
            Agents installed on this workspace.
          </DialogDescription>
        </header>
        {error && (
          <p role="alert" className="settings-error">
            {error}
            <button
              type="button"
              onClick={() =>
                void api
                  .installations()
                  .then(setItems)
                  .then(() => setError(''))
                  .catch(() => {})
              }
            >
              Retry
            </button>
          </p>
        )}
        {!items.length && !error && (
          <output className="settings-loading">
            <Loader2 className="animate-spin" size={15} />
            Checking providers…
          </output>
        )}
        <div className="settings-provider-list">
          {items.map((item) => {
            const updating = item.updateState === 'updating';
            const ready = item.snapshot.health === 'ready';
            const checking = busy === item.providerId;
            const showUpdate =
              updating ||
              item.updateState === 'failed' ||
              item.updateAvailable;
            const account =
              item.snapshot.accountLabel ??
              (ready ? 'Signed in' : 'Not signed in');
            return (
              <article
                className={`settings-provider-card${ready ? ' is-ready' : ''}${item.updateAvailable ? ' has-update' : ''}${item.updateState === 'failed' ? ' is-failed' : ''}`}
                key={item.providerId}
              >
                <div className="settings-provider-row">
                  <span className="settings-provider-logo">
                    <ProviderLogo provider={item.providerId} />
                  </span>
                  <div className="settings-provider-identity">
                    <h3>{item.name}</h3>
                    <p>
                      <span title={account}>{account}</span>
                      <i>·</i>
                      <span>
                        {item.installedVersion
                          ? `v${item.installedVersion}`
                          : 'Not installed'}
                      </span>
                    </p>
                  </div>
                  <span
                    className={`settings-health${ready ? ' is-ready' : ''}${item.updateAvailable ? ' has-update' : ''}`}
                  >
                    <i />
                    {item.updateAvailable && !updating
                      ? 'Update'
                      : healthLabel(item.snapshot.health)}
                  </span>
                  <button
                    type="button"
                    className="settings-refresh"
                    disabled={updating || !!busy}
                    aria-label={`Check ${item.name} for updates`}
                    title="Check for updates"
                    onClick={() => void action(item, false)}
                  >
                    <RefreshCw
                      size={14}
                      className={checking ? 'animate-spin' : ''}
                    />
                  </button>
                </div>
                {showUpdate && (
                  <div className="settings-update-area">
                    <p>
                      {updating
                        ? `Updating to ${item.latestVersion ?? 'the latest version'}…`
                        : item.updateState === 'failed'
                          ? (item.message ?? 'Update needs attention.')
                          : `Version ${item.latestVersion} is ready.`}
                    </p>
                    {item.updateAvailable && (
                      <button
                        className="settings-update-button"
                        type="button"
                        disabled={!item.canUpdate || updating || !!busy}
                        onClick={() => void action(item, true)}
                      >
                        <ArrowUpRight size={14} />
                        {updating
                          ? 'Updating…'
                          : item.canUpdate
                            ? `Update to ${item.latestVersion}`
                            : 'Update outside Webcode'}
                      </button>
                    )}
                  </div>
                )}
                {!ready && item.snapshot.message && (
                  <p className="settings-provider-note">
                    {item.snapshot.message}
                  </p>
                )}
              </article>
            );
          })}
        </div>
        {open && <SpeechSettings api={api} />}
      </DialogContent>
    </Dialog>
  );
}
