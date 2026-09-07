import type { ProviderLimits } from '../../lib/providers/limits.ts';
import { ProviderNotFoundError } from './provider-registry.ts';
type Reader = (signal: AbortSignal) => Promise<ProviderLimits>;
export class ProviderLimitsService {
  private cache = new Map<string, ProviderLimits>();
  private pending = new Map<string, Promise<ProviderLimits>>();
  private controllers = new Set<AbortController>();
  private closed = false;
  constructor(
    private readers: ReadonlyMap<string, Reader>,
    private now = Date.now,
    private ttl = 60000,
  ) {}
  read(id: string, force = false): Promise<ProviderLimits> {
    if (this.closed)
      return Promise.reject(new Error('Limits service is closed'));
    const reader = this.readers.get(id);
    if (!reader) throw new ProviderNotFoundError(id);
    const pending = this.pending.get(id);
    if (pending) return pending;
    const cached = this.cache.get(id);
    if (
      !force &&
      cached &&
      this.now() - Date.parse(cached.checkedAt) < this.ttl
    )
      return Promise.resolve(cached);
    const controller = new AbortController();
    this.controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), 10000);
    const work = Promise.race([
      Promise.resolve().then(() => reader(controller.signal)),
      new Promise<never>((_, reject) =>
        controller.signal.addEventListener(
          'abort',
          () => reject(new Error('Usage request cancelled')),
          { once: true },
        ),
      ),
    ])
      .catch(
        (): ProviderLimits => ({
          providerId: id,
          status: 'unavailable',
          checkedAt: new Date(this.now()).toISOString(),
          windows: [],
        }),
      )
      .then((value) => {
        this.cache.set(id, value);
        return value;
      })
      .finally(() => {
        clearTimeout(timer);
        this.controllers.delete(controller);
        this.pending.delete(id);
      });
    this.pending.set(id, work);
    return work;
  }
  async close() {
    this.closed = true;
    for (const controller of this.controllers) controller.abort();
    await Promise.allSettled(this.pending.values());
  }
}
