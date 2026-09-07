'use client';

import { useEffect, useState } from 'react';
import {
  Check,
  ChevronDown,
  Star,
  Search,
  SlidersHorizontal,
  ShieldCheck,
  LockKeyhole,
  ShieldOff,
  ArrowUpRight,
  Info,
  ImageIcon,
  X,
} from 'lucide-react';
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from '@/components/ui/popover';
import { ProviderLogo } from '@/components/provider-logo';
import type {
  ModelCapability,
  ProviderSnapshot,
} from '@/lib/providers/contracts';

import {
  permissionOptions,
  type PermissionMode,
} from '@/lib/workspace/permissions';

const favoriteKey = 'webcode.favorite-models.v1';
const providerName = (id: string) =>
  (({ codex: 'Codex', muse: 'Muse', grok: 'Grok' }) as Record<string, string>)[
    id
  ] ?? id.charAt(0).toUpperCase() + id.slice(1);
const effortDescription = (id: string) =>
  (
    ({
      none: 'No additional reasoning.',
      minimal: 'A light touch for straightforward requests.',
      low: 'Keep reasoning brief for everyday edits.',
      medium: 'More room to think through the task.',
      high: 'Spend more time working through complex problems.',
      xhigh: 'Extended reasoning for demanding work.',
      max: 'Use the highest reasoning setting available.',
      ultra: 'The most extensive reasoning available.',
    }) as Record<string, string>
  )[id] ?? 'Provider-supported reasoning level.';

export function ModelControls({
  providers,
  providerId,
  model,
  effort,
  effortCapability,
  providerLocked,
  disabled,
  onModel,
  onEffort,
  permissionMode,
  onPermissionMode,
}: {
  providers: readonly ProviderSnapshot[];
  providerId: string;
  model: string;
  effort: string;
  effortCapability?: ModelCapability;
  providerLocked: boolean;
  disabled: boolean;
  onModel: (provider: string, model: string) => void;
  onEffort: (effort: string) => void;
  permissionMode: PermissionMode;
  onPermissionMode: (mode: PermissionMode) => void;
}) {
  const [open, setOpen] = useState(false);
  const [permissionsOpen, setPermissionsOpen] = useState(false);
  const [effortOpen, setEffortOpen] = useState(false);
  const permissionLabel =
    permissionOptions.find((option) => option.id === permissionMode)?.label ??
    'Workspace';
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [favorites, setFavorites] = useState<string[]>([]);
  const currentProvider = providers.find((p) => p.providerId === providerId);
  const currentModel = currentProvider?.models.find((m) => m.id === model);
  const effortLabel =
    effortCapability?.values.find((v) => v.id === effort)?.label ?? 'Default';
  useEffect(() => {
    try {
      const value: unknown = JSON.parse(
        localStorage.getItem(favoriteKey) ?? '[]',
      );
      if (Array.isArray(value))
        queueMicrotask(() =>
          setFavorites(value.filter((v): v is string => typeof v === 'string')),
        );
    } catch {
      /* Favorites are optional on devices without local storage. */
    }
  }, []);
  function toggleFavorite(key: string) {
    const next = favorites.includes(key)
      ? favorites.filter((v) => v !== key)
      : [...favorites, key];
    setFavorites(next);
    try {
      localStorage.setItem(favoriteKey, JSON.stringify(next));
    } catch {
      /* Keep this session's selection. */
    }
  }
  const rows = providers
    .flatMap((provider) =>
      provider.models.map((item) => ({
        provider,
        item,
        key: `${provider.providerId}:${item.id}`,
      })),
    )
    .filter(
      (row) =>
        (filter === 'all' ||
          (filter === 'favorites' && favorites.includes(row.key)) ||
          filter === row.provider.providerId) &&
        `${row.item.label} ${row.item.id} ${row.provider.providerId}`
          .toLowerCase()
          .includes(query.trim().toLowerCase()),
    )
    .sort(
      (a, b) =>
        Number(favorites.includes(b.key)) - Number(favorites.includes(a.key)),
    );
  return (
    <fieldset className="model-controls" aria-label="Agent settings">
      <Popover
        open={open}
        onOpenChange={(value) => {
          setOpen(value);
          if (!value) setQuery('');
        }}
      >
        <PopoverTrigger
          className="model-control-trigger"
          disabled={disabled}
          aria-label={`Choose model. Current: ${currentModel?.label ?? model ?? 'Default'}`}
        >
          <span className="model-control-logo">
            <ProviderLogo provider={providerId} />
          </span>
          <span className="model-control-name">
            {currentModel?.label ?? (model || 'Choose model')}
          </span>
          <ChevronDown size={14} />
        </PopoverTrigger>
        <PopoverContent
          className="model-picker-panel"
          side="top"
          align="start"
          sideOffset={12}
        >
          <PopoverTitle className="sr-only">Choose a model</PopoverTitle>
          <div className="model-picker-search">
            <Search size={17} />
            <input
              aria-label="Search models"
              placeholder="Find a model…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  e.currentTarget
                    .closest('[data-slot="popover-content"]')
                    ?.querySelector<HTMLButtonElement>(
                      '[data-model-choice]:not(:disabled)',
                    )
                    ?.focus();
                }
              }}
            />
            {query && (
              <button
                type="button"
                aria-label="Clear search"
                onClick={() => setQuery('')}
              >
                <X size={14} />
              </button>
            )}
          </div>
          <div className="model-picker-filters" aria-label="Filter models">
            <button
              type="button"
              aria-pressed={filter === 'all'}
              onClick={() => setFilter('all')}
            >
              All models
            </button>
            <button
              type="button"
              aria-pressed={filter === 'favorites'}
              onClick={() => setFilter('favorites')}
            >
              <Star size={12} />
              Favorites
            </button>
            {providers.length > 1 &&
              providers.map((p) => (
                <button
                  type="button"
                  key={p.providerId}
                  className="model-picker-provider"
                  aria-label={providerName(p.providerId)}
                  title={providerName(p.providerId)}
                  aria-pressed={filter === p.providerId}
                  onClick={() => setFilter(p.providerId)}
                >
                  <ProviderLogo provider={p.providerId} />
                </button>
              ))}
          </div>
          <div className="model-picker-list" aria-label="Available models">
            {rows.map(({ provider, item, key }) => {
              const selected =
                provider.providerId === providerId && item.id === model;
              const locked =
                providerLocked && provider.providerId !== providerId;
              return (
                <div
                  className={`model-picker-row${selected ? ' is-current' : ''}`}
                  key={key}
                >
                  <button
                    type="button"
                    onKeyDown={(event) => {
                      if (
                        !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(
                          event.key,
                        )
                      )
                        return;
                      const choices = Array.from(
                        event.currentTarget.parentElement!.parentElement!.querySelectorAll<HTMLButtonElement>(
                          '[data-model-choice]:not(:disabled)',
                        ),
                      );
                      const index = choices.indexOf(
                        event.target as HTMLButtonElement,
                      );
                      if (index < 0 || !choices.length) return;
                      event.preventDefault();
                      choices[
                        event.key === 'Home'
                          ? 0
                          : event.key === 'End'
                            ? choices.length - 1
                            : (index +
                                (event.key === 'ArrowDown' ? 1 : -1) +
                                choices.length) %
                              choices.length
                      ]?.focus();
                    }}
                    data-model-choice
                    aria-pressed={selected}
                    disabled={locked || provider.health !== 'ready'}
                    className="model-picker-choice"
                    onClick={() => {
                      onModel(provider.providerId, item.id);
                      setOpen(false);
                      setQuery('');
                    }}
                  >
                    <span className="model-row-logo">
                      <ProviderLogo provider={provider.providerId} />
                    </span>
                    <span className="model-row-copy">
                      <strong>{item.label}</strong>
                      <span>
                        {providerName(provider.providerId)}
                        {locked ? (
                          ' · Start a new task to switch'
                        ) : provider.health !== 'ready' ? (
                          ' · Unavailable'
                        ) : item.inputModalities?.includes('image') ? (
                          <>
                            <span className="model-meta-dot">·</span>
                            <ImageIcon size={11} />
                            Images
                          </>
                        ) : null}
                      </span>
                    </span>
                    {selected ? (
                      <Check size={15} className="model-current-check" />
                    ) : item.isDefault ? (
                      <span className="model-default-badge">Default</span>
                    ) : null}
                  </button>
                  <button
                    type="button"
                    className="model-favorite"
                    aria-label={`${favorites.includes(key) ? 'Unfavorite' : 'Favorite'} ${item.label}`}
                    aria-pressed={favorites.includes(key)}
                    onClick={() => toggleFavorite(key)}
                  >
                    <Star size={15} />
                  </button>
                </div>
              );
            })}
            {!rows.length && (
              <div className="model-picker-empty">
                <Search size={22} />
                <strong>
                  {filter === 'favorites' && !query
                    ? 'Your shortlist starts here'
                    : 'No matching models'}
                </strong>
                <span>
                  {filter === 'favorites' && !query
                    ? 'Star a model to keep it close.'
                    : 'Try a different name or filter.'}
                </span>
              </div>
            )}
          </div>
          <div className="model-picker-bottom">
            <span>
              {providerLocked
                ? 'Provider is fixed for this task'
                : 'Models from your connected providers'}
            </span>
            <span className="model-key-hint">
              ↑ ↓ <span>navigate</span>
            </span>
          </div>
        </PopoverContent>
      </Popover>
      <span className="agent-setting-divider" aria-hidden="true" />
      <Popover
        open={effortOpen}
        onOpenChange={(value) => {
          setEffortOpen(value);
          if (value) {
            setOpen(false);
            setPermissionsOpen(false);
          }
        }}
      >
        <PopoverTrigger
          type="button"
          className="effort-control-trigger"
          disabled={disabled}
          aria-label={`Reasoning effort: ${effortLabel}`}
          title={`Reasoning effort: ${effortLabel}`}
        >
          <SlidersHorizontal size={16} />
          <span>{effortLabel}</span>
          <ChevronDown size={14} />
        </PopoverTrigger>
        <PopoverContent
          side="top"
          align="end"
          sideOffset={12}
          className="effort-picker-panel"
        >
          <div className="control-panel-heading">
            <PopoverTitle>Reasoning effort</PopoverTitle>
            <p>How much thinking to give this turn.</p>
          </div>
          {!effortCapability?.values.length && (
            <p className="control-panel-note">
              {currentProvider?.health === 'checking'
                ? 'Loading reasoning options…'
                : 'This model is not currently reporting configurable reasoning levels. Try refreshing the provider or choosing another model.'}
            </p>
          )}
          <div className="effort-choices">
            {effortCapability?.values.map((option, index) => (
              <button
                type="button"
                key={option.id}
                aria-pressed={effort === option.id}
                onClick={() => {
                  onEffort(option.id);
                  setEffortOpen(false);
                }}
              >
                <span className="effort-level" aria-hidden="true">
                  {[0, 1, 2, 3].map((bar) => (
                    <i
                      key={bar}
                      className={
                        bar <=
                        Math.round(
                          (index /
                            Math.max(1, effortCapability.values.length - 1)) *
                            3,
                        )
                          ? 'is-filled'
                          : ''
                      }
                    />
                  ))}
                </span>
                <span>
                  <strong>
                    {option.label}
                    {option.id === effortCapability.defaultValue && (
                      <small>Default</small>
                    )}
                  </strong>
                  <span>{effortDescription(option.id)}</span>
                </span>
                {effort === option.id && <Check size={14} />}
              </button>
            ))}
          </div>
          <p className="control-panel-note">
            Higher effort can take longer. Availability depends on the model.
          </p>
        </PopoverContent>
      </Popover>
      <span className="agent-setting-divider" aria-hidden="true" />
      <Popover open={permissionsOpen} onOpenChange={setPermissionsOpen}>
        <PopoverTrigger
          className={`permission-control-trigger${permissionMode === 'full-access' ? ' is-full-access' : ''}`}
          disabled={disabled}
          aria-label={`Configure permissions. Current: ${permissionLabel}`}
          title={`Permissions: ${permissionLabel}`}
        >
          {permissionMode === 'full-access' ? (
            <ShieldOff size={16} />
          ) : permissionMode === 'read-only' ? (
            <LockKeyhole size={16} />
          ) : (
            <ShieldCheck size={16} />
          )}
          <span>{permissionLabel}</span>
          <ChevronDown size={14} />
        </PopoverTrigger>
        <PopoverContent
          side="top"
          align="end"
          sideOffset={12}
          className="permissions-panel"
        >
          <div className="access-heading">
            <div>
              <PopoverTitle>Agent access</PopoverTitle>
              <span>Set the boundaries for this turn</span>
            </div>
            <span className="access-turn-badge">Next message</span>
          </div>
          <div className="access-options" aria-label="Permission modes">
            {permissionOptions.map((option) => {
              const selected = permissionMode === option.id;
              const Icon =
                option.id === 'full-access'
                  ? ShieldOff
                  : option.id === 'read-only'
                    ? LockKeyhole
                    : ShieldCheck;
              const summary =
                option.id === 'read-only'
                  ? 'Explore files without changing them.'
                  : option.id === 'workspace'
                    ? 'Edit your project. Ask for broader access.'
                    : 'Host files & network. No approval prompts.';
              return (
                <button
                  type="button"
                  key={option.id}
                  aria-pressed={selected}
                  className={`access-mode access-mode--${option.id}${selected ? ' is-selected' : ''}`}
                  onClick={() => {
                    onPermissionMode(option.id);
                    setPermissionsOpen(false);
                  }}
                >
                  <span className="access-mode-icon">
                    <Icon size={19} strokeWidth={1.6} />
                  </span>
                  <span className="access-mode-copy">
                    <span className="access-mode-title">
                      {option.label}
                      {option.id === 'workspace' && <small>Default</small>}
                      {option.id === 'full-access' && (
                        <ArrowUpRight size={12} />
                      )}
                    </span>
                    <span className="access-mode-summary">{summary}</span>
                  </span>
                  <span className="access-mode-indicator" aria-hidden="true">
                    {selected && <Check size={11} strokeWidth={2.5} />}
                  </span>
                </button>
              );
            })}
          </div>
          <details className="access-details" key={permissionMode}>
            <summary>
              <Info size={13} />
              <span>What can {permissionLabel.toLowerCase()} do?</span>
              <ChevronDown size={12} />
            </summary>
            <div className="access-detail-body">
              <dl>
                <div>
                  <dt>Files</dt>
                  <dd>
                    {permissionMode === 'read-only'
                      ? 'Read only'
                      : permissionMode === 'workspace'
                        ? 'Write to project & temporary folders'
                        : 'Host filesystem access'}
                  </dd>
                </div>
                <div>
                  <dt>Network</dt>
                  <dd>
                    {permissionMode === 'full-access'
                      ? 'Allowed'
                      : 'Disabled in the sandbox'}
                  </dd>
                </div>
                <div>
                  <dt>Broader access</dt>
                  <dd>
                    {permissionMode === 'read-only'
                      ? 'Not allowed'
                      : permissionMode === 'workspace'
                        ? 'Requires approval'
                        : 'No approval prompts'}
                  </dd>
                </div>
              </dl>
              {permissionMode === 'full-access' && (
                <p>
                  The selected agent runs without its sandbox, with the
                  permissions of the server’s OS account.
                </p>
              )}
            </div>
          </details>
        </PopoverContent>
      </Popover>
    </fieldset>
  );
}
