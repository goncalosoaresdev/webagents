import type { ProviderModel, ProviderSnapshot } from './contracts';

export function providerDisplayName(id: string): string {
  return (
    ({ codex: 'Codex', muse: 'Muse', grok: 'Grok' } as Record<string, string>)[
      id
    ] ?? id.charAt(0).toUpperCase() + id.slice(1)
  );
}

/** Keep supplied human labels; make machine-style fallbacks readable without changing IDs. */
export function modelDisplayName(
  model: Pick<ProviderModel, 'id' | 'label'>,
): string {
  const label = model.label.trim() || model.id;
  if (/\s/.test(label)) return label;
  return label
    .split(/[-_]/)
    .filter(Boolean)
    .map((word) =>
      word.toLowerCase() === 'gpt'
        ? 'GPT'
        : word.charAt(0).toUpperCase() + word.slice(1),
    )
    .join(' ');
}

export function workerChoices(
  providers: readonly ProviderSnapshot[],
  query: string,
) {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return providers
    .filter((provider) => provider.health === 'ready')
    .flatMap((provider) =>
      provider.models
        .filter((model) => {
          const searchable =
            `${provider.providerId} ${model.id} ${modelDisplayName(model)}`.toLowerCase();
          return terms.every((term) => searchable.includes(term));
        })
        .map((model) => ({
          providerId: provider.providerId,
          model,
          key: `${provider.providerId}:${model.id}`,
        })),
    );
}
