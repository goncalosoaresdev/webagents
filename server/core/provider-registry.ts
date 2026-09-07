import type {
  ProviderDiscovery,
  ProviderSnapshot,
} from '../../lib/providers/contracts.ts';

export interface ProviderRegistryOptions {
  cacheTtlMs: number;
  probeTimeoutMs: number;
  now?: () => number;
}

type SnapshotListener = (snapshot: ProviderSnapshot) => void;

export class ProviderRegistry {
  readonly #providers = new Map<string, ProviderDiscovery>();
  readonly #cache = new Map<
    string,
    { snapshot: ProviderSnapshot; cachedAt: number }
  >();
  readonly #inFlight = new Map<string, Promise<ProviderSnapshot>>();
  readonly #controllers = new Map<string, AbortController>();
  readonly #listeners = new Set<SnapshotListener>();
  readonly #cacheTtlMs: number;
  readonly #probeTimeoutMs: number;
  readonly #now: () => number;
  #closed = false;

  constructor(
    providers: readonly ProviderDiscovery[],
    options: ProviderRegistryOptions,
  ) {
    this.#cacheTtlMs = options.cacheTtlMs;
    this.#probeTimeoutMs = options.probeTimeoutMs;
    this.#now = options.now ?? Date.now;
    for (const provider of providers) {
      if (this.#providers.has(provider.id))
        throw new Error(`Duplicate provider id: ${provider.id}`);
      this.#providers.set(provider.id, provider);
    }
  }

  get ids(): readonly string[] {
    return [...this.#providers.keys()];
  }

  subscribe(listener: SnapshotListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async list(
    options: { force?: boolean } = {},
  ): Promise<readonly ProviderSnapshot[]> {
    return Promise.all(this.ids.map((id) => this.probe(id, options)));
  }

  async probe(
    providerId: string,
    options: { force?: boolean } = {},
  ): Promise<ProviderSnapshot> {
    if (this.#closed) throw new Error('Provider registry is closed');
    const provider = this.#providers.get(providerId);
    if (!provider) throw new ProviderNotFoundError(providerId);

    const cached = this.#cache.get(providerId);
    if (
      !options.force &&
      cached &&
      this.#now() - cached.cachedAt < this.#cacheTtlMs
    ) {
      return cached.snapshot;
    }

    const existing = this.#inFlight.get(providerId);
    if (existing) return existing;

    const operation = this.#runProbe(provider).finally(() =>
      this.#inFlight.delete(providerId),
    );
    this.#inFlight.set(providerId, operation);
    return operation;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const controller of this.#controllers.values()) {
      controller.abort(new Error('Provider registry is shutting down'));
    }
    await Promise.allSettled(this.#inFlight.values());
    this.#controllers.clear();
    this.#listeners.clear();
  }

  async #runProbe(provider: ProviderDiscovery): Promise<ProviderSnapshot> {
    const controller = new AbortController();
    this.#controllers.set(provider.id, controller);
    let rejectTimeout: (error: Error) => void;
    const timeoutPromise = new Promise<never>((_, reject) => {
      rejectTimeout = reject;
    });
    const timeout = setTimeout(() => {
      const error = new Error('Provider probe timed out');
      controller.abort(error);
      rejectTimeout(error);
    }, this.#probeTimeoutMs);
    timeout.unref?.();
    let snapshot: ProviderSnapshot;
    try {
      snapshot = await Promise.race([
        provider.probe(controller.signal),
        timeoutPromise,
      ]);
    } catch (error) {
      snapshot = {
        providerId: provider.id,
        health: 'unavailable',
        models: [],
        checkedAt: new Date(this.#now()).toISOString(),
        message: safeErrorMessage(error),
      };
    } finally {
      clearTimeout(timeout);
      this.#controllers.delete(provider.id);
    }

    if (snapshot.providerId !== provider.id) {
      throw new Error(
        `Provider ${provider.id} returned a snapshot for ${snapshot.providerId}`,
      );
    }
    this.#cache.set(provider.id, { snapshot, cachedAt: this.#now() });
    for (const listener of this.#listeners) {
      try {
        listener(snapshot);
      } catch {
        /* Subscribers cannot fail provider discovery. */
      }
    }
    return snapshot;
  }
}

export class ProviderNotFoundError extends Error {
  constructor(readonly providerId: string) {
    super(`Unknown provider: ${providerId}`);
    this.name = 'ProviderNotFoundError';
  }
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message)
    return error.message.slice(0, 500);
  return 'Provider probe failed';
}
