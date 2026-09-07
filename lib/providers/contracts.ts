export type ProviderHealth =
  | 'ready'
  | 'unauthenticated'
  | 'unavailable'
  | 'checking';

export interface ModelOption {
  id: string;
  label: string;
  description?: string;
  isDefault?: boolean;
}
export interface ModelCapability {
  id: string;
  label: string;
  values: readonly ModelOption[];
  defaultValue?: string;
}
export interface ProviderModel {
  inputModalities?: readonly string[];
  id: string;
  isDefault?: boolean;
  label: string;
  capabilities: readonly ModelCapability[];
}

export interface ProviderSnapshot {
  providerId: string;
  health: ProviderHealth;
  version?: string;
  accountLabel?: string;
  models: readonly ProviderModel[];
  checkedAt: string;
  message?: string;
}

/** Discovery and execution are registered together at the composition root. */
export interface ProviderDiscovery {
  readonly id: string;
  probe(signal?: AbortSignal): Promise<ProviderSnapshot>;
}
