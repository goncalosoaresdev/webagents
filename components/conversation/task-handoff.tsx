'use client';

import { useState } from 'react';
import { ArrowRightLeft, MoreHorizontal } from 'lucide-react';
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from '@/components/ui/popover';
import { ProviderLogo } from '@/components/provider-logo';
import type { ProviderSnapshot } from '@/lib/providers/contracts';

const providerName = (id: string) =>
  (({ codex: 'Codex', muse: 'Muse', grok: 'Grok' }) as Record<string, string>)[
    id
  ] ?? id.charAt(0).toUpperCase() + id.slice(1);

export function TaskHandoff({
  providers,
  currentProviderId,
  disabled,
  running,
  busy,
  onHandoff,
}: {
  providers: readonly ProviderSnapshot[];
  currentProviderId: string;
  disabled: boolean;
  running: boolean;
  busy: boolean;
  onHandoff: (providerId: string, model?: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const destinations = providers.filter(
    (provider) =>
      provider.providerId !== currentProviderId && provider.health === 'ready',
  );
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        className="toolbar-more"
        aria-label="Task actions"
        title="Task actions"
      >
        <MoreHorizontal />
      </PopoverTrigger>
      <PopoverContent className="task-menu-panel" align="end" sideOffset={8}>
        <PopoverTitle className="sr-only">Task actions</PopoverTitle>
        <p className="task-menu-copy">
          Hand off to another agent if this one is out of limits or stuck.
        </p>
        {running ? (
          <p className="task-menu-note">Stop the current turn first.</p>
        ) : disabled ? (
          <p className="task-menu-note">Open a conversation to hand it off.</p>
        ) : !destinations.length ? (
          <p className="task-menu-note">No other ready agents available.</p>
        ) : (
          <div className="task-handoff-list" aria-label="Hand off to">
            {destinations.map((provider) => {
              const model =
                provider.models.find((item) => item.isDefault)?.id ??
                provider.models[0]?.id;
              return (
                <button
                  type="button"
                  key={provider.providerId}
                  disabled={busy}
                  onClick={() => {
                    onHandoff(provider.providerId, model);
                    setOpen(false);
                  }}
                >
                  <span className="task-handoff-logo">
                    <ProviderLogo provider={provider.providerId} />
                  </span>
                  <span>
                    <strong>{providerName(provider.providerId)}</strong>
                    <span>
                      {provider.models.find((item) => item.id === model)
                        ?.label ??
                        model ??
                        'Default model'}
                    </span>
                  </span>
                  <ArrowRightLeft size={14} />
                </button>
              );
            })}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
