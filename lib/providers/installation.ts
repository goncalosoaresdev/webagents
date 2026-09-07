import type { ProviderSnapshot } from './contracts.ts';
export interface ProviderInstallation {
  providerId: string;
  name: string;
  snapshot: ProviderSnapshot;
  installedVersion?: string;
  latestVersion?: string;
  updateAvailable: boolean;
  canUpdate: boolean;
  updateState: 'idle' | 'updating' | 'succeeded' | 'failed';
  message?: string;
  checkedAt: string;
}
