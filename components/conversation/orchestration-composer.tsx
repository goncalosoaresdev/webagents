/* oxlint-disable jsx-a11y/prefer-tag-over-role -- The autocomplete uses a styled listbox with active-descendant keyboard navigation. */
import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from 'react';
import { Check, X } from 'lucide-react';
import { Textarea } from '@/components/ui/textarea';
import { ProviderLogo } from '@/components/provider-logo';
import type { Orchestration } from '@/lib/workspace/contracts';
import type { ProviderSnapshot } from '@/lib/providers/contracts';
import {
  modelDisplayName,
  providerDisplayName,
  workerChoices,
} from '@/lib/providers/display';
import { providerMention } from '@/lib/workspace/orchestration';

export function OrchestrationComposer({
  inputRef,
  prompt,
  onPrompt,
  orchestration,
  onOrchestration,
  providers,
  leadLabel,
  disabled,
  onSend,
}: {
  inputRef: RefObject<HTMLTextAreaElement | null>;
  prompt: string;
  onPrompt: (value: string) => void;
  orchestration?: Orchestration;
  onOrchestration: (value: Orchestration | undefined) => void;
  providers: readonly ProviderSnapshot[];
  leadLabel: string;
  disabled: boolean;
  onSend: () => void;
}) {
  const listId = useId();
  const readableLead = modelDisplayName({
    id: leadLabel || 'Current model',
    label: leadLabel,
  });
  const rootRef = useRef<HTMLDivElement>(null);
  const armedWorker = providers.find(
    (entry) => entry.providerId === orchestration?.worker.providerId,
  );
  const armedModel = armedWorker?.models.find(
    (model) => model.id === orchestration?.worker.model,
  );
  const armedLabel = armedModel
    ? modelDisplayName(armedModel)
    : orchestration
      ? modelDisplayName({ id: orchestration.worker.model, label: '' })
      : '';
  const [mention, setMention] = useState<{
    query: string;
    start: number;
    end: number;
  }>();
  const [index, setIndex] = useState(0);
  if (disabled && mention !== undefined) setMention(undefined);
  const open = Boolean(mention) && !disabled;
  const choices = workerChoices(providers, mention?.query ?? '');
  const showRemove = Boolean(orchestration);
  const total = (showRemove ? 1 : 0) + choices.length;
  const selectedIndex = Math.min(index, Math.max(0, total - 1));

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !rootRef.current?.contains(event.target)
      )
        setMention(undefined);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  useEffect(() => {
    if (open)
      document
        .getElementById(`${listId}-${selectedIndex}`)
        ?.scrollIntoView({ block: 'nearest' });
  }, [open, listId, selectedIndex]);

  function choose(choice: (typeof choices)[number]) {
    onOrchestration({
      worker: {
        providerId: choice.providerId,
        model: choice.model.id,
        reasoningEffort: choice.model.capabilities.find(
          (capability) => capability.id === 'reasoningEffort',
        )?.defaultValue,
      },
    });
    if (mention)
      onPrompt(
        `${prompt.slice(0, mention.start)}${modelDisplayName(choice.model)}${prompt.slice(mention.end)}`,
      );
    setMention(undefined);
    inputRef.current?.focus();
  }
  function chooseRemove() {
    if (mention)
      onPrompt(`${prompt.slice(0, mention.start)}${prompt.slice(mention.end)}`);
    onOrchestration(undefined);
    setMention(undefined);
    inputRef.current?.focus();
  }
  function pickerKey(event: KeyboardEvent): boolean {
    if (!open || event.nativeEvent.isComposing) return false;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      setMention(undefined);
      inputRef.current?.focus();
      return true;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setIndex(
        (selectedIndex +
          (event.key === 'ArrowDown' ? 1 : -1) +
          Math.max(total, 1)) %
          Math.max(total, 1),
      );
      return true;
    }
    if ((event.key === 'Enter' || event.key === 'Tab') && !event.shiftKey) {
      if (selectedIndex === 0 && showRemove) {
        event.preventDefault();
        chooseRemove();
      } else if (choices.length) {
        event.preventDefault();
        choose(choices[selectedIndex - (showRemove ? 1 : 0)]);
      } else if (event.key === 'Enter') event.preventDefault();
      return true;
    }
    return false;
  }
  const activeDescendant =
    open && total ? `${listId}-${selectedIndex}` : undefined;
  return (
    <div
      className="orchestration-composer"
      ref={rootRef}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget))
          setMention(undefined);
      }}
    >
      <Textarea
        ref={inputRef}
        aria-label="Message"
        value={prompt}
        disabled={disabled}
        aria-autocomplete="list"
        aria-controls={open ? listId : undefined}
        aria-activedescendant={activeDescendant}
        placeholder="Ask for a change…"
        onChange={(event) => {
          const value = event.target.value;
          onPrompt(value);
          if (orchestration && armedLabel && !value.includes(armedLabel))
            onOrchestration(undefined);
          const next = providerMention(
            event.target.value,
            event.target.selectionStart,
          );
          setMention(next);
          setIndex(orchestration ? 1 : 0);
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || pickerKey(event)) return;
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            onSend();
          }
        }}
      />
      {open && (
        <div className="orchestration-picker">
          <div className="worker-picker-heading">
            <strong>Choose a worker</strong>
            <span>{readableLead} plans and reviews.</span>
          </div>
          <div
            id={listId}
            role="listbox"
            aria-label="Worker model"
            className="worker-model-list"
          >
            {showRemove && (
              <button
                type="button"
                role="option"
                aria-selected={false}
                data-active={selectedIndex === 0}
                id={`${listId}-0`}
                tabIndex={-1}
                onMouseDown={(event) => event.preventDefault()}
                onClick={chooseRemove}
                className="worker-option-remove"
              >
                <X size={14} aria-hidden="true" />
                <span className="worker-option-name">
                  Remove worker · send as a single model
                </span>
              </button>
            )}
            {providers
              .filter((provider) =>
                choices.some(
                  (choice) => choice.providerId === provider.providerId,
                ),
              )
              .map((provider) => (
                <div
                  role="group"
                  aria-label={providerDisplayName(provider.providerId)}
                  key={provider.providerId}
                >
                  <div className="worker-provider-heading">
                    <ProviderLogo provider={provider.providerId} />
                    <span>{providerDisplayName(provider.providerId)}</span>
                  </div>
                  {choices
                    .filter(
                      (choice) => choice.providerId === provider.providerId,
                    )
                    .map((choice) => {
                      const optionIndex =
                        choices.indexOf(choice) + (showRemove ? 1 : 0);
                      const selected =
                        orchestration?.worker.providerId ===
                          choice.providerId &&
                        orchestration.worker.model === choice.model.id;
                      return (
                        <button
                          type="button"
                          role="option"
                          aria-selected={selected}
                          data-active={optionIndex === selectedIndex}
                          id={`${listId}-${optionIndex}`}
                          key={choice.key}
                          tabIndex={-1}
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={() => choose(choice)}
                          title={choice.model.id}
                        >
                          <span className="worker-option-name">
                            {modelDisplayName(choice.model)}
                          </span>
                          {selected ? (
                            <Check size={14} />
                          ) : choice.model.isDefault ? (
                            <span className="worker-default">Default</span>
                          ) : null}
                        </button>
                      );
                    })}
                </div>
              ))}
            {!choices.length && (
              <p className="worker-empty">
                No available models match. Check provider settings or try
                another search.
              </p>
            )}
          </div>
          <div className="worker-picker-footer">
            <span>
              <kbd>↑</kbd>
              <kbd>↓</kbd> Navigate
            </span>
            <span>
              <kbd>↵</kbd> Select
            </span>
            <span>
              <kbd>esc</kbd> Close
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
