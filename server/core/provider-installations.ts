import type { ProviderInstallation } from '../../lib/providers/installation.ts';
import type { InstallationDriver } from './installation-driver.ts';
import { isNewerVersion } from './installation-driver.ts';
import {
  ProviderNotFoundError,
  type ProviderRegistry,
} from './provider-registry.ts';
import { ConflictError } from '../storage/errors.ts';
export class ProviderInstallations {
  private cache = new Map<string, ProviderInstallation>();
  private reads = new Map<string, Promise<ProviderInstallation>>();
  private updates = new Map<string, Promise<void>>();
  private closed = false;
  constructor(
    private readonly drivers: ReadonlyMap<
      string,
      { name: string; driver: InstallationDriver }
    >,
    private readonly providers: ProviderRegistry,
    private readonly isBusy: () => boolean,
  ) {}
  isUpdating = () => this.updates.size > 0;
  async list() {
    return Promise.all([...this.drivers.keys()].map((id) => this.read(id)));
  }
  read(id: string, force = false): Promise<ProviderInstallation> {
    const entry = this.drivers.get(id);
    if (!entry) throw new ProviderNotFoundError(id);
    const cached = this.cache.get(id);
    if (
      cached &&
      (this.updates.has(id) ||
        (!force && Date.now() - Date.parse(cached.checkedAt) < 60000))
    )
      return Promise.resolve(cached);
    const pending = this.reads.get(id);
    if (pending) return pending;
    const reading = (async () => {
      const [installation, snapshot, release] = await Promise.all([
        entry.driver.inspect(),
        this.providers.probe(id, { force: true }),
        entry.driver.latest().then(
          (version) => ({ version, error: undefined }),
          () => ({
            version: undefined,
            error: 'Could not check for updates. Try again.',
          }),
        ),
      ]);
      const result: ProviderInstallation = {
        providerId: id,
        name: entry.name,
        snapshot,
        installedVersion: installation.version,
        latestVersion: release.version,
        updateAvailable: Boolean(
          installation.version &&
          release.version &&
          isNewerVersion(installation.version, release.version),
        ),
        canUpdate: installation.canUpdate,
        updateState: 'idle',
        message: release.error ?? installation.message,
        checkedAt: new Date().toISOString(),
      };
      this.cache.set(id, result);
      return result;
    })().finally(() => this.reads.delete(id));
    this.reads.set(id, reading);
    return reading;
  }
  async update(id: string) {
    if (this.closed) throw new ConflictError('Server is shutting down.');
    const state = await this.read(id, true);
    if (this.closed) throw new ConflictError('Server is shutting down.');
    if (this.updates.has(id)) return this.cache.get(id)!;
    if (this.isBusy())
      throw new ConflictError(
        'Wait for running tasks to finish before updating.',
      );
    if (!state.canUpdate || !state.updateAvailable || !state.latestVersion)
      throw new ConflictError('No supported update is available.');
    const updating: ProviderInstallation = {
      ...state,
      updateState: 'updating',
      message: `Updating ${state.name}. New messages will be available when the update finishes.`,
    };
    this.cache.set(id, updating);
    const work = Promise.resolve().then(async () => {
      try {
        await this.drivers.get(id)!.driver.update(state.latestVersion!);
        const installed = await this.drivers.get(id)!.driver.inspect();
        if (
          !installed.version ||
          (installed.version !== state.latestVersion &&
            !isNewerVersion(state.latestVersion!, installed.version))
        )
          throw new Error('Version verification failed');
        const snapshot = await this.providers.probe(id, { force: true });
        this.cache.set(id, {
          ...updating,
          snapshot,
          installedVersion: installed.version,
          updateAvailable: false,
          updateState: 'succeeded',
          message: `${state.name} updated successfully.`,
          checkedAt: new Date().toISOString(),
        });
      } catch {
        this.cache.set(id, {
          ...updating,
          updateState: 'failed',
          message:
            'The update could not be verified. Check server permissions and connectivity, then check again.',
          checkedAt: new Date().toISOString(),
        });
      } finally {
        this.updates.delete(id);
      }
    });
    this.updates.set(id, work);
    return updating;
  }
  async close() {
    this.closed = true;
    await Promise.allSettled(this.updates.values());
  }
}
