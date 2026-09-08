import { GitFork } from 'lucide-react';
import type { Orchestration } from '@/lib/workspace/contracts';
import type { ProviderSnapshot } from '@/lib/providers/contracts';
import {
  modelDisplayName,
  providerDisplayName,
} from '@/lib/providers/display';

/**
 * Read-only orchestration indicator for the top context strip. It never opens
 * a picker and has no click behavior: workers are armed only by typing an
 * `@`-mention in the message box, and this indicator glows while one is set.
 */
export function OrchestrationSelect({
  orchestration,
  providers,
}: {
  orchestration?: Orchestration;
  providers: readonly ProviderSnapshot[];
}) {
  const worker = providers.find(
    (entry) => entry.providerId === orchestration?.worker.providerId,
  );
  const selectedModel = worker?.models.find(
    (model) => model.id === orchestration?.worker.model,
  );
  const selectedLabel = selectedModel
    ? modelDisplayName(selectedModel)
    : orchestration
      ? modelDisplayName({ id: orchestration.worker.model, label: '' })
      : '';
  const unavailable = Boolean(
    orchestration && (worker?.health !== 'ready' || !selectedModel),
  );
  return (
    <output
      className={`orchestration-trigger${orchestration ? ' is-active' : ''}${unavailable ? ' is-unavailable' : ''}`}
      aria-label={
        orchestration
          ? `Orchestration on. Worker: ${providerDisplayName(orchestration.worker.providerId)}, ${selectedLabel}${unavailable ? '. Model unavailable' : ''}.`
          : 'Orchestration off. Type @ in your message to choose a worker.'
      }
      title={
        orchestration
          ? `Orchestration on · worker ${providerDisplayName(orchestration.worker.providerId)} ${selectedLabel}.${unavailable ? ' Model unavailable.' : ''}`
          : 'Type @ in your message to choose a worker model'
      }
    >
      <GitFork size={14} aria-hidden="true" /> Orchestrate
    </output>
  );
}
